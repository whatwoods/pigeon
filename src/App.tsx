import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  Feather,
  FileUp,
  Laptop,
  Link,
  Lock,
  Plus,
  Smartphone,
  Tablet,
  Monitor,
  AlertTriangle,
  RefreshCw,
  Users,
  X
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api";
import { deriveAesKey, decryptText, encryptText } from "./lib/crypto";
import { ensureDeviceIdentity, type DeviceIdentity } from "./lib/deviceIdentity";
import { createLocalPackage, type LocalPackage } from "./lib/filePackage";
import { FileVisual } from "./FileVisual";
import { formatBytes, formatCount } from "./lib/format";
import { PackageReceiver, PackageSender, type ConnectionRoute, type ProgressEvent } from "./lib/peerTransfer";
import { createReceiveSink } from "./lib/receiveSink";
import { clearRoomSession, loadRoomSession, saveRoomSession, type StoredRoomSession } from "./lib/roomIdentity";
import { openSignalSocket, type SignalSocket } from "./lib/signaling";
import type {
  PackageAcceptMessage,
  PackageOfferMessage,
  PackageRejectMessage,
  RoomDevicePresence,
  RtcAnswerMessage,
  RtcIceMessage,
  RtcOfferMessage,
  SignalMessage,
  TextOfferMessage,
  TextPayloadMessage,
  TurnResponse
} from "./shared/protocol";

type ViewState = "idle" | "file_preview" | "sharing_link" | "enter_code" | "waiting" | "sending" | "success" | "error";
type SendState = "idle" | "selected" | "waiting" | "sending" | "sent" | "error";
type SignalSource = "room" | "pair";

interface PairSession {
  code: string;
  url: string;
  socket: SignalSocket;
}

interface IncomingText {
  text: string;
  from: string;
}

interface IncomingPackage {
  offer: PackageOfferMessage;
  source: SignalSource;
}

interface PendingTextSend {
  id: string;
  text: string;
  source: SignalSource;
  socket?: SignalSocket;
  expectedReceiverIds?: Set<string>;
}

const EMPTY_TURN: TurnResponse = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const CONNECTION_ROUTE_LABELS: Record<ConnectionRoute, string> = {
  checking: "正在尝试直连",
  lan: "局域网直连",
  direct: "点对点直连",
  relay: "正在中继"
};

const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function inferDeviceType(uaOrName: string): "mobile" | "tablet" | "desktop" {
  const str = uaOrName.toLowerCase();
  if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(str)) return "tablet";
  if (/mobile|ip(hone|od)|android|blackberry|iemobile|kindle|silk-accelerated|(hpw|web)os|opera m(obi|ini)/i.test(str)) return "mobile";
  if (str.includes("phone")) return "mobile";
  return "desktop";
}

function getDeviceIcon(type: "mobile" | "tablet" | "desktop") {
  if (type === "mobile") return <Smartphone />;
  if (type === "tablet") return <Tablet />;
  return <Laptop />;
}

export default function App() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [roomSession, setRoomSession] = useState<StoredRoomSession | null>(null);
  const [onlineDevices, setOnlineDevices] = useState<RoomDevicePresence[]>([]);
  const [status, setStatus] = useState("准备就绪");
  const [view, setView] = useState<ViewState>("idle");
  const [localPackage, setLocalPackage] = useState<LocalPackage | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const [incomingText, setIncomingText] = useState<IncomingText | null>(null);
  const [incomingPackage, setIncomingPackage] = useState<IncomingPackage | null>(null);
  const [pairSession, setPairSession] = useState<PairSession | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [connectionRoute, setConnectionRoute] = useState<ConnectionRoute | null>(null);
  const [receiveCode, setReceiveCode] = useState("");
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showDeviceHint, setShowDeviceHint] = useState(false);
  const [deviceInviteUrl, setDeviceInviteUrl] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [turn, setTurn] = useState<TurnResponse>(EMPTY_TURN);
  const [toast, setToast] = useState<{ message: string; type: "success" | "warning" | "error" | "info" } | null>(null);

  const showToast = useCallback((message: string, type: "success" | "warning" | "error" | "info" = "info") => {
    setToast({ message, type });
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const identityRef = useRef<DeviceIdentity | null>(null);
  const roomSocketRef = useRef<SignalSocket | null>(null);
  const pendingPairSocket = useRef<SignalSocket | null>(null);
  const handleSignalRef = useRef<(message: SignalMessage, source: SignalSource) => Promise<void> | void>(() => undefined);
  const activeSenders = useRef(new Map<string, PackageSender>());
  const activeReceiver = useRef<PackageReceiver | null>(null);
  const pendingText = useRef<PendingTextSend | null>(null);
  const packageSources = useRef(new Map<string, SignalSource>());
  const pendingPackageTargets = useRef(new Map<string, Set<string>>());
  const offerTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const urlPairCode = useMemo(() => new URLSearchParams(window.location.search).get("code"), []);
  const urlRoomInvite = useMemo(() => new URLSearchParams(window.location.search).get("roomInvite"), []);
  const otherOnlineDevices = onlineDevices.filter((device) => device.deviceId !== identity?.deviceId);
  const isPreviewingText = view === "file_preview" && !!clipboardText && !localPackage;
  const currentProgressPercent = progress ? Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100)) : 0;

  useEffect(() => {
    let cancelled = false;

    ensureDeviceIdentity()
      .then(async (nextIdentity) => {
        if (cancelled) return;
        identityRef.current = nextIdentity;
        setIdentity(nextIdentity);
        refreshTurn();

        const session = await ensureRoom(nextIdentity);
        if (cancelled) return;
        setRoomSession(session);
        connectRoom(session, nextIdentity);

        if (urlPairCode) {
          setReceiveCode(urlPairCode.toUpperCase());
          setView("enter_code");
          connectPairReceiver(urlPairCode.toUpperCase(), nextIdentity);
        }
      })
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : "初始化失败");
        setView("error");
      });

    return () => {
      cancelled = true;
      stopOfferResend();
      roomSocketRef.current?.close();
      pendingPairSocket.current?.close();
      pairSession?.socket.close();
      activeSenders.current.forEach((sender) => sender.cancel());
      activeReceiver.current?.close();
    };
  }, [urlPairCode, urlRoomInvite]);

  const prevOnlineDevicesRef = useRef<RoomDevicePresence[]>([]);
  const hasInitializedPresence = useRef(false);
  const prevRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    const currentRoomId = roomSession?.roomId || null;
    if (currentRoomId !== prevRoomIdRef.current) {
      prevRoomIdRef.current = currentRoomId;
      hasInitializedPresence.current = false;
      prevOnlineDevicesRef.current = [];
    }

    if (!currentRoomId) return;

    if (!hasInitializedPresence.current) {
      if (onlineDevices.length > 0) {
        hasInitializedPresence.current = true;
        prevOnlineDevicesRef.current = onlineDevices;
      }
      return;
    }

    const prev = prevOnlineDevicesRef.current;
    const currentOthers = onlineDevices.filter((d) => d.deviceId !== identity?.deviceId);
    const prevOthers = prev.filter((d) => d.deviceId !== identity?.deviceId);

    const newOthers = currentOthers.filter(
      (curr) => !prevOthers.some((p) => p.deviceId === curr.deviceId)
    );

    if (newOthers.length > 0) {
      newOthers.forEach((device) => {
        showToast(`${device.deviceName} 已上线`, "success");
      });
    }

    prevOnlineDevicesRef.current = onlineDevices;
  }, [onlineDevices, roomSession?.roomId, identity?.deviceId, showToast]);

  async function ensureRoom(nextIdentity: DeviceIdentity): Promise<StoredRoomSession> {
    if (urlRoomInvite) {
      const joined = await api.joinRoom(urlRoomInvite, registrationPayload(nextIdentity));
      const session = { roomId: joined.roomId, roomToken: joined.roomToken, deviceId: joined.deviceId };
      saveRoomSession(session);
      window.history.replaceState({}, "", window.location.pathname);
      return session;
    }

    const existing = loadRoomSession(nextIdentity);
    if (existing) {
      try {
        const res = await api.verifyRoom(existing.roomId, existing.roomToken, existing.deviceId);
        if (res.valid) {
          return existing;
        }
        clearRoomSession();
      } catch (error) {
        throw error;
      }
    }

    const created = await api.createRoom(registrationPayload(nextIdentity));
    const session = { roomId: created.roomId, roomToken: created.roomToken, deviceId: created.deviceId };
    saveRoomSession(session);
    return session;
  }

  function registrationPayload(nextIdentity: DeviceIdentity) {
    return {
      deviceId: nextIdentity.deviceId,
      deviceName: nextIdentity.deviceName,
      publicKey: nextIdentity.publicKey
    };
  }

  function connectRoom(session: StoredRoomSession, nextIdentity: DeviceIdentity) {
    roomSocketRef.current?.close();
    const path =
      `/ws/room/${encodeURIComponent(session.roomId)}` +
      `?deviceId=${encodeURIComponent(nextIdentity.deviceId)}` +
      `&token=${encodeURIComponent(session.roomToken)}` +
      `&deviceName=${encodeURIComponent(nextIdentity.deviceName)}`;

    roomSocketRef.current = openSignalSocket(path, {
      onOpen: () => setStatus("准备就绪"),
      onMessage: (message) => handleSignalRef.current(message, "room"),
      onClose: () => setStatus("房间连接已断开"),
      onError: () => setStatus("房间连接失败")
    });
  }

  function refreshTurn() {
    api.turn().then(setTurn).catch(() => setTurn(EMPTY_TURN));
  }

  async function handleSignal(message: SignalMessage, source: SignalSource) {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) return;

    try {
      if (message.type === "room:presence") {
        setOnlineDevices(message.onlineDevices);
        return;
      }

      if (message.type === "text:offer") {
        acceptTextOffer(message, currentIdentity, source);
        return;
      }

      if (message.type === "text:accept") {
        await sendPairedText(message);
        return;
      }

      if (message.type === "text:payload") {
        const key = await deriveAesKey(currentIdentity.privateKey, message.senderPublicKey);
        const text = await decryptText(message.iv, message.ciphertext, key);
        setIncomingText({ text, from: message.senderDeviceId });
        setStatus("收到文本");
        setView("success");
        return;
      }

      if (message.type === "package:offer") {
        packageSources.current.set(message.packageId, source);
        setIncomingPackage({ offer: message, source });
        setConnectionRoute(null);
        setProgress(null);
        setStatus("收到投递包");
        return;
      }

      if (message.type === "package:accept") {
        markPackageAccepted(message.packageId, message.receiverDeviceId);
        await beginSendingToReceiver(message);
        return;
      }

      if (message.type === "package:reject") {
        setStatus("对方已拒绝");
        return;
      }

      if (message.type === "rtc:answer") {
        await handleRtcAnswer(message);
        return;
      }

      if (message.type === "rtc:offer") {
        await activeReceiver.current?.handleOffer(message);
        return;
      }

      if (message.type === "rtc:ice") {
        await handleRtcIce(message);
        return;
      }

      if (message.type === "transfer:cancel") {
        cancelTransfer("传输已取消");
      }
    } catch (error) {
      setSendState("error");
      setStatus(error instanceof Error ? error.message : "传输失败");
      setView("error");
    }
  }

  useEffect(() => {
    handleSignalRef.current = handleSignal;
  });

  function connectPairReceiver(code: string, nextIdentity = identityRef.current) {
    if (!nextIdentity) return;
    pendingPairSocket.current?.close();
    pendingPairSocket.current = openSignalSocket(
      `/ws/pair/${encodeURIComponent(code)}?role=receiver&deviceId=${encodeURIComponent(nextIdentity.deviceId)}`,
      {
        onOpen: () => setStatus("等待配对内容"),
        onMessage: (message) => handleSignalRef.current(message, "pair"),
        onClose: () => setStatus("配对已结束"),
        onError: () => {
          setStatus("配对失败");
          setShakeError(true);
          showToast("提取码无效或已过期", "error");
          setTimeout(() => {
            setShakeError(false);
            setReceiveCode("");
          }, 600);
        }
      }
    );
  }

  function acceptTextOffer(offer: TextOfferMessage, currentIdentity: DeviceIdentity, source: SignalSource) {
    const socket = source === "room" ? roomSocketRef.current : pendingPairSocket.current;
    if (!socket) return;
    socket.send({
      type: "text:accept",
      id: offer.id,
      targetDeviceId: offer.senderDeviceId,
      receiverDeviceId: currentIdentity.deviceId,
      receiverPublicKey: currentIdentity.publicKey
    });
    setStatus("正在接收文本");
  }

  async function sendPairedText(message: Extract<SignalMessage, { type: "text:accept" }>) {
    const currentIdentity = identityRef.current;
    const pending = pendingText.current;
    if (!currentIdentity || !pending || pending.id !== message.id) return;
    if (pending.expectedReceiverIds && !pending.expectedReceiverIds.has(message.receiverDeviceId)) return;

    const key = await deriveAesKey(currentIdentity.privateKey, message.receiverPublicKey);
    const encrypted = await encryptText(pending.text, key);
    const payload: TextPayloadMessage = {
      type: "text:payload",
      id: pending.id,
      targetDeviceId: message.receiverDeviceId,
      senderDeviceId: currentIdentity.deviceId,
      senderPublicKey: currentIdentity.publicKey,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      createdAt: Date.now()
    };
    (pending.source === "room" ? roomSocketRef.current : pending.socket)?.send(payload);

    if (pending.expectedReceiverIds) {
      pending.expectedReceiverIds.delete(message.receiverDeviceId);
      if (pending.expectedReceiverIds.size > 0) {
        setStatus(`已送达一台设备，等待 ${pending.expectedReceiverIds.size} 台设备接收`);
        return;
      }
    }

    stopOfferResend();
    pendingText.current = null;
    setSendState("sent");
    setStatus("已送达");
    setView("success");
  }

  async function handleFiles(list: FileList | File[] | null) {
    if (!list || !identity) return;
    setStatus("正在整理投递包");
    try {
      closePairSession();
      pendingText.current = null;
      pendingPackageTargets.current.clear();
      setClipboardText("");
      const nextPackage = await createLocalPackage(list, identity.deviceId);
      setLocalPackage(nextPackage);
      setSendState("selected");
      setProgress(null);
      setConnectionRoute(null);
      setStatus(nextPackage.warnings[0] ?? "投递包已就绪");
      setView("file_preview");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "无法选择文件");
      setSendState("error");
      setView("error");
    }
  }

  async function handlePasteClick() {
    try {
      let items: ClipboardItems | undefined;
      try {
        items = await navigator.clipboard.read?.();
      } catch (err) {
        // Ignore read() errors (e.g. unsupported formats), fallback to readText()
      }

      if (items) {
        const pastedFiles: File[] = [];
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("text/")) continue;
            const blob = await item.getType(type);
            const name = type.startsWith("image/")
              ? `pasted_image.${blob.type.split("/")[1] || "png"}`
              : `pasted_file.${inferExtension(blob.type)}`;
            pastedFiles.push(new File([blob], name, { type: blob.type || type }));
          }
        }
        if (pastedFiles.length > 0) {
          await handleFiles(pastedFiles);
          return;
        }
      }

      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        if (items) {
          showToast("剪贴板为空", "warning");
        } else {
          document.body.focus();
          showToast(IS_MOBILE ? "无法读取剪切板文件，请手动选择文件" : "无法读取文件，请尝试快捷键 Ctrl+V / Cmd+V 粘贴", "warning");
        }
        return;
      }
      setClipboardText(text);
      setLocalPackage(null);
      pendingPackageTargets.current.clear();
      setSendState("selected");
      setStatus("文本已就绪");
      setView("file_preview");
    } catch {
      document.body.focus();
      showToast(IS_MOBILE ? "无法读取剪切板，请检查权限或选择文件" : "请使用快捷键 Ctrl+V / Cmd+V 粘贴", "warning");
    }
  }

  useEffect(() => {
    const handleGlobalPaste = (event: ClipboardEvent) => {
      if (view !== "idle" && view !== "enter_code") return;
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        void handleFiles(files);
        return;
      }

      const items = event.clipboardData?.items;
      if (items) {
        const pastedFiles: File[] = [];
        for (const item of items) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) pastedFiles.push(file);
          }
        }
        if (pastedFiles.length > 0) {
          void handleFiles(pastedFiles);
          return;
        }
      }

      const text = event.clipboardData?.getData("text");
      if (!text) return;
      if (view === "enter_code" && text.length <= 12) {
        setReceiveCode(text.toUpperCase());
      } else {
        setClipboardText(text);
        setLocalPackage(null);
        pendingPackageTargets.current.clear();
        setView("file_preview");
        setStatus("文本已就绪");
      }
    };

    window.addEventListener("paste", handleGlobalPaste);
    return () => window.removeEventListener("paste", handleGlobalPaste);
  }, [view, identity]);

  function sendToSelf() {
    if (!identity) return;
    if (otherOnlineDevices.length === 0) {
      setStatus("请先添加一台设备");
      setShowDeviceHint(true);
      void createDeviceInvite();
      return;
    }

    const targetDeviceIds = otherOnlineDevices.map((device) => device.deviceId);

    if (localPackage) {
      packageSources.current.set(localPackage.manifest.packageId, "room");
      pendingPackageTargets.current.set(localPackage.manifest.packageId, new Set(targetDeviceIds));
      sendRoomPackageOffers(localPackage, targetDeviceIds);
      startOfferResend(() => sendRoomPackageOffers(localPackage));
      setSendState("waiting");
      setView("waiting");
      setStatus(`等待 ${otherOnlineDevices.length} 台设备接收`);
      return;
    }

    if (clipboardText) {
      const textId = crypto.randomUUID();
      const offer: TextOfferMessage = {
        type: "text:offer",
        deliveryScope: "room",
        id: textId,
        senderDeviceId: identity.deviceId,
        senderPublicKey: identity.publicKey,
        createdAt: Date.now()
      };
      pendingText.current = { id: textId, text: clipboardText, source: "room", expectedReceiverIds: new Set(targetDeviceIds) };
      sendRoomTextOffers(offer, targetDeviceIds);
      startOfferResend(() => sendRoomTextOffers(offer));
      setSendState("waiting");
      setView("waiting");
      setStatus(`等待 ${targetDeviceIds.length} 台设备接收文本`);
    }
  }

  function sendRoomPackageOffers(nextPackage: LocalPackage, targetDeviceIds?: string[]) {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) return;
    const remaining = targetDeviceIds ?? [...(pendingPackageTargets.current.get(nextPackage.manifest.packageId) ?? [])];
    for (const targetDeviceId of remaining) {
      const offer: PackageOfferMessage = {
        type: "package:offer",
        deliveryScope: "room",
        packageId: nextPackage.manifest.packageId,
        targetDeviceId,
        senderDeviceId: currentIdentity.deviceId,
        senderPublicKey: currentIdentity.publicKey,
        manifest: nextPackage.manifest,
        createdAt: Date.now()
      };
      roomSocketRef.current?.send(offer);
    }
  }

  function sendRoomTextOffers(offer: TextOfferMessage, targetDeviceIds?: string[]) {
    const pending = pendingText.current;
    const remaining = targetDeviceIds ?? [...(pending?.expectedReceiverIds ?? [])];
    for (const targetDeviceId of remaining) {
      roomSocketRef.current?.send({ ...offer, targetDeviceId });
    }
  }

  function markPackageAccepted(packageId: string, receiverDeviceId: string) {
    const targets = pendingPackageTargets.current.get(packageId);
    if (!targets) {
      stopOfferResend();
      return;
    }
    targets.delete(receiverDeviceId);
    if (targets.size === 0) {
      pendingPackageTargets.current.delete(packageId);
      stopOfferResend();
    }
  }

  async function shareToOthers() {
    if (!identity) return;
    try {
      const pair = await api.createPair();
      const socket = openSignalSocket(
        `/ws/pair/${encodeURIComponent(pair.code)}?role=sender&deviceId=${encodeURIComponent(identity.deviceId)}`,
        {
          onOpen: () => {
            const offer = createPairOffer(pair.code, socket);
            if (offer) {
              socket.send(offer);
              startOfferResend(() => socket.send(offer));
            }
          },
          onMessage: (message) => handleSignalRef.current(message, "pair"),
          onClose: () => setStatus("配对已结束"),
          onError: () => setStatus("配对失败")
        }
      );

      pendingPairSocket.current = socket;
      setPairSession({ code: pair.code, url: pair.url, socket });
      setSendState("waiting");
      setView("sharing_link");
      setStatus("等待对方接收");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "无法创建接收码");
      setView("error");
    }
  }

  function createPairOffer(code: string, socket?: SignalSocket): PackageOfferMessage | TextOfferMessage | null {
    const currentIdentity = identityRef.current;
    if (!currentIdentity) return null;

    if (localPackage) {
      packageSources.current.set(localPackage.manifest.packageId, "pair");
      return {
        type: "package:offer",
        deliveryScope: "pair",
        packageId: localPackage.manifest.packageId,
        senderDeviceId: currentIdentity.deviceId,
        senderPublicKey: currentIdentity.publicKey,
        manifest: localPackage.manifest,
        createdAt: Date.now()
      };
    }

    if (clipboardText) {
      const existing = pendingText.current;
      const id = existing?.id || crypto.randomUUID();
      pendingText.current = { id, text: clipboardText, source: "pair", socket: socket ?? pendingPairSocket.current ?? undefined };
      return {
        type: "text:offer",
        deliveryScope: "pair",
        id,
        senderDeviceId: currentIdentity.deviceId,
        senderPublicKey: currentIdentity.publicKey,
        createdAt: Date.now()
      };
    }

    setStatus(`接收码 ${code} 已创建`);
    return null;
  }

  async function beginSendingToReceiver(message: PackageAcceptMessage) {
    const currentIdentity = identityRef.current;
    if (!currentIdentity || !localPackage) return;
    if (activeSenders.current.has(message.receiverDeviceId)) return;
    setConnectionRoute("checking");
    setSendState("sending");
    setView("sending");
    const key = await deriveAesKey(currentIdentity.privateKey, message.receiverPublicKey);
    const sender = new PackageSender({
      manifest: localPackage.manifest,
      files: localPackage.files,
      aesKey: key,
      targetDeviceId: message.receiverDeviceId,
      senderDeviceId: currentIdentity.deviceId,
      iceServers: turn.iceServers as RTCIceServer[],
      signal: (signal) => sendPackageSignal(localPackage.manifest.packageId, signal),
      onProgress: (event) => {
        setProgress(event);
        setSendState("sending");
        setStatus("正在飞行");
      },
      onConnectionRoute: (route) => {
        setConnectionRoute(route);
        setStatus(routeStatusText(route));
      },
      onRetry: (attempt) => {
        setConnectionRoute("checking");
        setSendState("sending");
        setView("sending");
        setStatus(`连接中断，正在第 ${attempt} 次重试`);
      },
      onComplete: () => {
        activeSenders.current.delete(message.receiverDeviceId);
        const waitingTargets = pendingPackageTargets.current.get(localPackage.manifest.packageId)?.size ?? 0;
        if (activeSenders.current.size === 0 && waitingTargets === 0) {
          setSendState("sent");
          setStatus("已送达");
          setView("success");
        } else if (activeSenders.current.size === 0) {
          setSendState("waiting");
          setStatus(`已送达一台设备，等待 ${waitingTargets} 台设备接收`);
          setView("waiting");
        } else {
          setStatus("已送达一台设备，继续发送");
        }
      },
      onError: (error) => {
        setSendState("error");
        setStatus(error.message);
        setView("error");
      }
    });
    activeSenders.current.set(message.receiverDeviceId, sender);
    await sender.start();
  }

  async function acceptIncomingPackage() {
    const currentIdentity = identityRef.current;
    if (!currentIdentity || !incomingPackage) return;
    const { offer, source } = incomingPackage;

    try {
      packageSources.current.set(offer.packageId, source);
      setConnectionRoute("checking");
      setView("sending");
      setStatus("正在尝试直连");
      const { sink, mode } = await createReceiveSink(offer.manifest);
      const key = await deriveAesKey(currentIdentity.privateKey, offer.senderPublicKey);
      const receiver = new PackageReceiver({
        packageId: offer.packageId,
        receiverDeviceId: currentIdentity.deviceId,
        senderDeviceId: offer.senderDeviceId,
        aesKey: key,
        iceServers: turn.iceServers as RTCIceServer[],
        sink,
        signal: (signal) => sendPackageSignal(offer.packageId, signal),
        onProgress: (event) => {
          setProgress(event);
          setStatus(mode === "directory" ? "正在写入文件夹" : "正在下载");
        },
        onConnectionRoute: (route) => {
          setConnectionRoute(route);
          setStatus(routeStatusText(route));
        },
        onComplete: () => {
          setIncomingPackage(null);
          setConnectionRoute(null);
          setStatus("已接收");
          setView("success");
        },
        onError: (error) => {
          setStatus(error.message);
          setView("error");
        }
      });
      activeReceiver.current = receiver;
      sendPackageSignal(offer.packageId, {
        type: "package:accept",
        packageId: offer.packageId,
        targetDeviceId: offer.senderDeviceId,
        receiverDeviceId: currentIdentity.deviceId,
        receiverPublicKey: currentIdentity.publicKey
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus(error instanceof Error ? error.message : "无法接收投递包");
      setView("error");
    }
  }

  function rejectIncomingPackage() {
    const currentIdentity = identityRef.current;
    if (!currentIdentity || !incomingPackage) return;
    const { offer } = incomingPackage;
    const message: PackageRejectMessage = {
      type: "package:reject",
      packageId: offer.packageId,
      targetDeviceId: offer.senderDeviceId,
      receiverDeviceId: currentIdentity.deviceId,
      reason: "拒绝"
    };
    sendPackageSignal(offer.packageId, message);
    setIncomingPackage(null);
    setConnectionRoute(null);
    setView("idle");
    showToast("已拒绝", "warning");
  }

  function sendPackageSignal(packageId: string, message: PackageAcceptMessage | PackageRejectMessage | RtcOfferMessage | RtcAnswerMessage | RtcIceMessage) {
    const source = packageSources.current.get(packageId) ?? "pair";
    if (source === "room") {
      roomSocketRef.current?.send(message);
    } else {
      (pairSession?.socket ?? pendingPairSocket.current)?.send(message);
    }
  }

  async function handleRtcAnswer(message: RtcAnswerMessage) {
    await activeSenders.current.get(message.receiverDeviceId)?.handleAnswer(message);
  }

  async function handleRtcIce(message: RtcIceMessage) {
    const sender = activeSenders.current.get(message.senderDeviceId);
    if (sender) {
      await sender.handleIce(message);
      return;
    }
    await activeReceiver.current?.handleIce(message);
  }

  async function createDeviceInvite() {
    setCopiedLink(false);
    setShowAddDevice(true);
    if (!roomSession) return;
    try {
      const invite = await api.createRoomInvite(roomSession.roomId, roomSession.roomToken);
      setDeviceInviteUrl(invite.url);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "无法创建设备链接");
    }
  }

  async function createFreshRoom() {
    if (!identity) return;
    if (!window.confirm("退出当前房间会断开已添加设备，需要重新邀请。确定要新建连接吗？")) return;
    try {
      stopOfferResend();
      closePairSession();
      activeSenders.current.forEach((sender) => sender.cancel());
      activeSenders.current.clear();
      pendingPackageTargets.current.clear();
      activeReceiver.current?.close();
      activeReceiver.current = null;
      roomSocketRef.current?.close();
      clearRoomSession();
      setOnlineDevices([]);
      setDeviceInviteUrl("");
      setStatus("正在创建新房间");

      const created = await api.createRoom(registrationPayload(identity));
      const session = { roomId: created.roomId, roomToken: created.roomToken, deviceId: created.deviceId };
      saveRoomSession(session);
      setRoomSession(session);
      connectRoom(session, identity);
      setShowAddDevice(false);
      showToast("已进入新房间", "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "无法创建新房间");
      setView("error");
    }
  }

  async function copyValue(value: string, kind: "link" | "code") {
    await navigator.clipboard.writeText(value);
    if (kind === "link") {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } else {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    }
  }

  async function submitReceiveCode() {
    const code = receiveCode.trim().toUpperCase();
    if (!code || !identity) return;
    connectPairReceiver(code, identity);
    setStatus("等待配对内容");
  }

  async function copyReceivedText() {
    if (!incomingText) return;
    await navigator.clipboard.writeText(incomingText.text);
    showToast("已复制文本", "success");
  }

  function reset() {
    stopOfferResend();
    closePairSession();
    activeSenders.current.forEach((sender) => sender.cancel());
    activeSenders.current.clear();
    pendingPackageTargets.current.clear();
    activeReceiver.current?.close();
    activeReceiver.current = null;
    setLocalPackage(null);
    setClipboardText("");
    setIncomingText(null);
    setIncomingPackage(null);
    setSendState("idle");
    setProgress(null);
    setConnectionRoute(null);
    setReceiveCode("");
    setStatus("准备就绪");
    setView("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function closePairSession() {
    stopOfferResend();
    pairSession?.socket.close();
    if (pendingPairSocket.current !== pairSession?.socket) pendingPairSocket.current?.close();
    pendingPairSocket.current = null;
    setPairSession(null);
  }

  function cancelTransfer(label = "已取消") {
    activeSenders.current.forEach((sender) => sender.cancel());
    activeSenders.current.clear();
    activeReceiver.current?.close();
    closePairSession();
    pendingText.current = null;
    pendingPackageTargets.current.clear();
    setLocalPackage(null);
    setSendState("idle");
    setProgress(null);
    setConnectionRoute(null);
    setStatus(label);
    setView("idle");
  }

  function startOfferResend(sendOffer: () => void) {
    stopOfferResend();
    offerTimer.current = window.setInterval(sendOffer, 2000) as any;
  }

  function stopOfferResend() {
    if (!offerTimer.current) return;
    window.clearInterval(offerTimer.current);
    offerTimer.current = null;
  }

  function handleDragEnter(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleDragLeave(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (event.dataTransfer.files?.[0]) void handleFiles(event.dataTransfer.files);
  }

  return (
    <div className="app-shell" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDrop={handleDrop}>
      <NoiseOverlay />
      <OrganicBackground />
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`toast-alert ${toast.type}`}
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            onAnimationComplete={() => {
              setTimeout(() => setToast(null), 2500);
            }}
          >
            {toast.type === "success" ? <Check /> : toast.type === "info" ? <Feather /> : <AlertTriangle />}
            <span>{toast.message}</span>
          </motion.div>
        )}
        {showAddDevice ? (
          <AddDeviceModal
            inviteUrl={deviceInviteUrl}
            identity={identity}
            onlineDevices={onlineDevices}
            copied={copiedLink}
            onCopy={() => deviceInviteUrl && copyValue(deviceInviteUrl, "link")}
            onRefreshInvite={createDeviceInvite}
            onCreateRoom={createFreshRoom}
            onClose={() => setShowAddDevice(false)}
          />
        ) : null}
      </AnimatePresence>

      {dragActive && view === "idle" ? <DragOverlay onDragLeave={handleDragLeave} onDrop={handleDrop} /> : null}

      <motion.header
        className="topbar"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        <button className="brand-button" onClick={reset} aria-label="Pigeon 首页">
          <span className="brand-mark"><Feather /></span>
          <span>Pigeon</span>
        </button>
        <div className="topbar-actions">
          <div className="device-pill-wrapper">
            <button className="device-pill" onClick={createDeviceInvite}>
              {otherOnlineDevices.length > 0 ? <span className="online-dot" /> : <Plus />}
              <span>{otherOnlineDevices.length > 0 ? `${onlineDevices.length} 台设备在线` : "添加设备"}</span>
            </button>
            <AnimatePresence>
              {showDeviceHint && (
                <motion.div
                  className="device-hint-popover"
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  onAnimationComplete={() => setTimeout(() => setShowDeviceHint(false), 3000)}
                >
                  <div className="popover-arrow" />
                  请先在这里添加设备
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <InstallButton />
        </div>
      </motion.header>

      <main className="workspace" aria-live="polite">
        <AnimatePresence mode="wait">
          {incomingPackage && view !== "sending" && view !== "success" ? (
            <IncomingPackageCard
              key="incoming"
              incomingPackage={incomingPackage}
              onAccept={acceptIncomingPackage}
              onReject={rejectIncomingPackage}
            />
          ) : incomingText ? (
            <ReceivedTextCard key="incoming-text" text={incomingText.text} onCopy={copyReceivedText} onClose={reset} />
          ) : view === "file_preview" ? (
            <PreviewCard
              key="preview"
              localPackage={localPackage}
              clipboardText={clipboardText}
              isPreviewingText={isPreviewingText}
              deviceCount={otherOnlineDevices.length}
              onSendSelf={sendToSelf}
              onShare={shareToOthers}
              onReset={reset}
            />
          ) : view === "sharing_link" && pairSession ? (
            <SharingCard
              key="sharing"
              pairSession={pairSession}
              copiedCode={copiedCode}
              copiedLink={copiedLink}
              onCopyCode={() => copyValue(pairSession.code, "code")}
              onCopyLink={() => copyValue(pairSession.url, "link")}
              onClose={reset}
            />
          ) : view === "enter_code" ? (
            <ReceiveCodeCard
              key="receive"
              value={receiveCode}
              onChange={setReceiveCode}
              onSubmit={submitReceiveCode}
              onClose={reset}
              hasError={shakeError}
            />
          ) : view === "waiting" ? (
            <WaitingCard key="waiting" status={status} onCancel={() => cancelTransfer()} localType={inferDeviceType(navigator.userAgent)} />
          ) : view === "sending" ? (
            <SendingCard
              key="sending"
              percent={currentProgressPercent}
              route={connectionRoute}
              status={status}
              onCancel={() => cancelTransfer()}
              localType={inferDeviceType(navigator.userAgent)}
              remoteType={
                activeReceiver.current
                  ? inferDeviceType(onlineDevices.find((d) => d.deviceId === incomingPackage?.offer.senderDeviceId)?.deviceName || "mobile")
                  : inferDeviceType(onlineDevices.find((d) => activeSenders.current.has(d.deviceId))?.deviceName || "mobile")
              }
            />
          ) : view === "success" ? (
            <SuccessCard key="success" status={status} onDone={reset} />
          ) : view === "error" ? (
            <ErrorCard key="error" status={status} onClose={reset} />
          ) : (
            <IdleCard
              key="idle"
              status={status}
              fileInputRef={fileInputRef}
              onFiles={handleFiles}
              onPaste={handlePasteClick}
              onReceive={() => setView("enter_code")}
            />
          )}
        </AnimatePresence>
      </main>

      <footer className="footer-links">
        <span>隐私政策</span>
        <span>/</span>
        <span>使用条款</span>
      </footer>
    </div>
  );
}

function IdleCard({
  status,
  fileInputRef,
  onFiles,
  onPaste,
  onReceive
}: {
  status: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (list: FileList | null) => void;
  onPaste: () => void;
  onReceive: () => void;
}) {
  return (
    <GlassCard className="idle-card">
      <div className="card-intro">
        <p>{IS_MOBILE ? "选择文件，即可分享" : "选择或拖入文件，即可分享"}</p>
      </div>
      <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => onFiles(event.currentTarget.files)} />
      <div className="orb-button-wrap">
        <motion.div className="orb-halo" animate={{ scale: [1, 1.05, 1], opacity: [0.35, 0.62, 0.35] }} transition={{ duration: 4, repeat: Infinity }} />
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }} className="file-orb" onClick={() => fileInputRef.current?.click()}>
          <FileUp />
          <span>选择文件</span>
        </motion.button>
      </div>
      <div className="card-actions">
        <button className="primary-action" onClick={onPaste}>
          <ClipboardPaste />
          <span>粘贴投送</span>
        </button>
        <button className="soft-action" onClick={onReceive}>
          <Download />
          <span>接收文件</span>
        </button>
      </div>
    </GlassCard>
  );
}

function PreviewCard({
  localPackage,
  clipboardText,
  isPreviewingText,
  deviceCount,
  onSendSelf,
  onShare,
  onReset
}: {
  localPackage: LocalPackage | null;
  clipboardText: string;
  isPreviewingText: boolean;
  deviceCount: number;
  onSendSelf: () => void;
  onShare: () => void;
  onReset: () => void;
}) {
  return (
    <GlassCard className="preview-card">
      <CardHeader label="已选择内容" onClose={onReset} />
      <div className="preview-body">
        {isPreviewingText ? (
          <div className="text-preview">{clipboardText}</div>
        ) : (
          <>
            <FileVisual name={localPackage?.manifest.name} isFolder={localPackage ? localPackage.manifest.entries.length > 1 : false} />
            <h2 title={localPackage?.manifest.name}>{localPackage?.manifest.name}</h2>
            <p>{localPackage ? `${formatCount(localPackage.manifest.entries.length)} · ${formatBytes(localPackage.manifest.totalBytes)}` : ""}</p>
            {localPackage?.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}
          </>
        )}
      </div>
      <div className="card-actions">
        <button className="primary-action" onClick={onSendSelf}>
          {deviceCount > 0 ? `发给 ${deviceCount} 台设备` : "添加我的设备"}
        </button>
        <button className="soft-action" onClick={onShare}>
          <Link />
          <span>分享给他人</span>
        </button>
      </div>
    </GlassCard>
  );
}

function SharingCard({
  pairSession,
  copiedCode,
  copiedLink,
  onCopyCode,
  onCopyLink,
  onClose
}: {
  pairSession: PairSession;
  copiedCode: boolean;
  copiedLink: boolean;
  onCopyCode: () => void;
  onCopyLink: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (pairSession.url && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, pairSession.url, {
        width: 140,
        margin: 1,
        color: {
          dark: "#4a4947",
          light: "#ffffff00"
        }
      });
    }
  }, [pairSession.url]);

  return (
    <GlassCard className="share-card">
      <CardHeader label="分享文件" onClose={onClose} />
      <div className="share-body" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <h2>文件已就绪</h2>
        <p>对方扫描二维码，或输入下方提取码接收</p>
        <div className="qr-container" style={{ margin: "16px 0 8px" }}>
          <canvas ref={canvasRef} />
        </div>
        <strong style={{ fontSize: "2.2rem", letterSpacing: "6px", margin: "8px 0" }}>{pairSession.code}</strong>
      </div>
      <div className="split-actions">
        <button className="soft-action" onClick={onCopyCode}>
          {copiedCode ? <Check /> : <Copy />}
          <span>{copiedCode ? "已复制" : "复制提取码"}</span>
        </button>
        <button className="primary-action" onClick={onCopyLink}>
          {copiedLink ? <Check /> : <Link />}
          <span>{copiedLink ? "已复制" : "复制链接"}</span>
        </button>
      </div>
    </GlassCard>
  );
}

function ReceiveCodeCard({
  value,
  onChange,
  onSubmit,
  onClose,
  hasError
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  hasError: boolean;
}) {
  const codeArray = Array.from({ length: 6 }, (_, i) => value[i] || "");
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (value === "") {
      inputsRef.current[0]?.focus();
    }
  }, [value]);

  const handleInputChange = (char: string, index: number) => {
    const newCode = value.split("");
    newCode[index] = char.slice(-1).toUpperCase();
    const result = newCode.join("").slice(0, 6);
    onChange(result);

    if (char && index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
    
    if (result.length === 6) {
      // Allow state to update before submitting
      setTimeout(onSubmit, 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === "Backspace" && !codeArray[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
      const newCode = value.split("");
      newCode[index - 1] = "";
      onChange(newCode.join(""));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (pastedData) {
      onChange(pastedData.slice(0, 6));
      const nextFocusIndex = Math.min(pastedData.length, 5);
      inputsRef.current[nextFocusIndex]?.focus();
      if (pastedData.length >= 6) {
        setTimeout(onSubmit, 50);
      }
    }
  };

  return (
    <GlassCard className="receive-card">
      <CardHeader label="接收文件" onClose={onClose} />
      <div className={`receive-body ${hasError ? "shake-animation" : ""}`}>
        <p className="receive-hint">请输入发送方提供的 6 位提取码</p>
        <div className="segmented-code-input">
          {codeArray.map((char, index) => (
            <input
              key={index}
              ref={(el) => { inputsRef.current[index] = el; }}
              className={char ? "has-value" : ""}
              value={char}
              onChange={(e) => handleInputChange(e.target.value, index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              onPaste={handlePaste}
              aria-label={`提取码第 ${index + 1} 位`}
              maxLength={1}
              autoFocus={index === 0}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
          ))}
        </div>
      </div>
    </GlassCard>
  );
}

function IncomingPackageCard({
  incomingPackage,
  onAccept,
  onReject
}: {
  incomingPackage: IncomingPackage;
  onAccept: () => void;
  onReject: () => void;
}) {
  const manifest = incomingPackage.offer.manifest;
  return (
    <GlassCard className="preview-card">
      <div className="panel-title">
        <span>接收请求</span>
      </div>
      <div className="preview-body">
        <FileVisual name={manifest.name} isFolder={manifest.entries.length > 1} />
        <h2 title={manifest.name}>{manifest.name}</h2>
        <p>{formatCount(manifest.entries.length)} · {formatBytes(manifest.totalBytes)}</p>
      </div>
      <div className="split-actions">
        <button className="primary-action" onClick={onAccept}>接收</button>
        <button className="soft-action" onClick={onReject}>拒绝</button>
      </div>
    </GlassCard>
  );
}

function ReceivedTextCard({ text, onCopy, onClose }: { text: string; onCopy: () => void; onClose: () => void }) {
  return (
    <GlassCard className="preview-card">
      <CardHeader label="收到文本" onClose={onClose} />
      <div className="preview-body">
        <div className="text-preview received">{text}</div>
      </div>
      <div className="card-actions">
        <button className="primary-action" onClick={onCopy}>复制文本</button>
      </div>
    </GlassCard>
  );
}

function WaitingCard({ status, onCancel, localType }: { status: string; onCancel: () => void; localType: "desktop" | "mobile" | "tablet" }) {
  return (
    <GlassCard className="sending-card">
      <div className="flight-icons">
        {getDeviceIcon(localType)}
        <span />
        {getDeviceIcon(localType === "desktop" ? "mobile" : "desktop")}
      </div>
      <p>{status}</p>
      <button className="plain-cancel" onClick={onCancel}>取消</button>
    </GlassCard>
  );
}

function SendingCard({
  percent,
  route,
  status,
  onCancel,
  localType,
  remoteType
}: {
  percent: number;
  route: ConnectionRoute | null;
  status: string;
  onCancel: () => void;
  localType: "desktop" | "mobile" | "tablet";
  remoteType: "desktop" | "mobile" | "tablet";
}) {
  return (
    <GlassCard className="sending-card">
      <div className="progress-ring" style={{ "--percent": percent } as React.CSSProperties}>
        <svg viewBox="0 0 192 192">
          <circle cx="96" cy="96" r="90" />
          <circle cx="96" cy="96" r="90" pathLength="100" />
        </svg>
        <motion.div animate={{ y: [-4, 4, -4] }} transition={{ duration: 3, repeat: Infinity }}>
          <Feather />
        </motion.div>
      </div>
      <div className="flight-icons">
        {getDeviceIcon(localType)}
        <span />
        {getDeviceIcon(remoteType)}
      </div>
      <p>{route ? CONNECTION_ROUTE_LABELS[route] : status}</p>
      <small>{percent}%</small>
      <button className="plain-cancel" onClick={onCancel}>取消</button>
    </GlassCard>
  );
}

function SuccessCard({ status, onDone }: { status: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 2500);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return (
    <GlassCard className="success-card">
      <div className="success-icon"><Check /></div>
      <h2>{status === "已接收" ? "成功接收" : "成功送达"}</h2>
      <p>{status}</p>
    </GlassCard>
  );
}

function ErrorCard({ status, onClose }: { status: string; onClose: () => void }) {
  return (
    <GlassCard className="success-card">
      <div className="success-icon error"><X /></div>
      <h2>操作失败</h2>
      <p>{status}</p>
      <button className="soft-action single" onClick={onClose}>返回</button>
    </GlassCard>
  );
}

function AddDeviceModal({
  inviteUrl,
  identity,
  onlineDevices,
  copied,
  onCopy,
  onRefreshInvite,
  onCreateRoom,
  onClose
}: {
  inviteUrl: string;
  identity: DeviceIdentity | null;
  onlineDevices: RoomDevicePresence[];
  copied: boolean;
  onCopy: () => void;
  onRefreshInvite: () => void;
  onCreateRoom: () => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const devices = onlineDevices.length > 0
    ? onlineDevices
    : identity
      ? [{ deviceId: identity.deviceId, deviceName: identity.deviceName }]
      : [];

  useEffect(() => {
    if (inviteUrl && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, inviteUrl, {
        width: 160,
        margin: 1,
        color: {
          dark: "#4a4947",
          light: "#ffffff00"
        }
      });
    }
  }, [inviteUrl]);

  return (
    <div className="modal-layer">
      <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="add-device-modal room-modal" initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.95 }}>
        
        <div className="panel-title" style={{ marginBottom: "8px" }}>
          <div><span>邀请设备加入</span></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X /></button>
        </div>

        <div className="room-invite-block" style={{ marginBottom: "8px" }}>
          <div className="qr-container">
            {inviteUrl ? <canvas ref={canvasRef} /> : <span className="qr-placeholder">生成链接中</span>}
          </div>
          <div className="split-actions room-actions">
            <button className="soft-action" onClick={onRefreshInvite}>
              <RefreshCw />
              <span>刷新链接</span>
            </button>
            <button className="primary-action" onClick={onCopy} disabled={!inviteUrl}>
              {copied ? <Check /> : <Copy />}
              <span>{copied ? "已复制" : "复制链接"}</span>
            </button>
          </div>
        </div>

        <div className="room-device-list">
          {devices.map((device) => (
            <div className="room-device-row" key={device.deviceId}>
              <span className="room-device-icon">{getDeviceIcon(inferDeviceType(device.deviceName))}</span>
              <span className="room-device-name" title={device.deviceName}>{device.deviceName}</span>
              <span className="room-device-status">{device.deviceId === identity?.deviceId ? "本机" : "在线"}</span>
            </div>
          ))}
        </div>

        <button className="soft-action room-reset-action danger-action" onClick={onCreateRoom} style={{ marginTop: "4px" }}>
          <span>退出当前房间并新建</span>
        </button>

      </motion.div>
    </div>
  );
}

function CardHeader({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="panel-title">
      <div>
        <span>{label}</span>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="关闭"><X /></button>
    </div>
  );
}

function GlassCard({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <motion.section
      className={`glass-card ${className}`}
      initial={{ opacity: 0, scale: 0.95, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, filter: "blur(4px)" }}
      transition={{ duration: 0.38 }}
    >
      <div className="card-sheen" />
      <div className="card-content">{children}</div>
    </motion.section>
  );
}

function DragOverlay({ onDragLeave, onDrop }: { onDragLeave: (event: React.DragEvent) => void; onDrop: (event: React.DragEvent) => void }) {
  return (
    <div className="drag-overlay" onDragLeave={onDragLeave} onDrop={onDrop}>
      <div>松开鼠标即可传送</div>
    </div>
  );
}

function NoiseOverlay() {
  return (
    <svg className="noise-overlay" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <filter id="noiseFilter">
        <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noiseFilter)" />
    </svg>
  );
}

function OrganicBackground() {
  return (
    <div className="organic-bg" aria-hidden="true">
      <motion.div animate={{ rotate: [0, 5, -5, 0], scale: [1, 1.05, 0.95, 1] }} transition={{ duration: 20, repeat: Infinity }} />
      <motion.div animate={{ rotate: [0, -5, 5, 0], scale: [1, 0.95, 1.05, 1] }} transition={{ duration: 25, repeat: Infinity, delay: 1 }} />
      <motion.div animate={{ rotate: [0, 10, -10, 0] }} transition={{ duration: 15, repeat: Infinity }} />
    </div>
  );
}

function InstallButton() {
  const [prompt, setPrompt] = useState<Event | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!prompt) return null;
  return (
    <button
      className="install-button"
      onClick={() => {
        const installPrompt = prompt as Event & { prompt?: () => Promise<void> };
        void installPrompt.prompt?.();
        setPrompt(null);
      }}
    >
      安装
    </button>
  );
}

function routeStatusText(route: ConnectionRoute): string {
  return CONNECTION_ROUTE_LABELS[route];
}

function inferExtension(type: string): string {
  const subtype = type.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) return "bin";
  if (subtype === "jpeg") return "jpg";
  if (subtype.includes("+")) return subtype.split("+")[0] || "bin";
  return subtype.replace(/[^a-z0-9]/gi, "") || "bin";
}
