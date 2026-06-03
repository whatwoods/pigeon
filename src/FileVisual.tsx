import React from "react";
import {
  FileText,
  Folder,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  FileCode,
  File as FileIcon
} from "lucide-react";

export function FileVisual({ name, isFolder }: { name?: string; isFolder?: boolean }) {
  const ext = name ? name.split(".").pop()?.toLowerCase() : "";

  let type = "default";
  if (isFolder) {
    type = "folder";
  } else if (ext) {
    if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) type = "image";
    else if (["mp4", "webm", "mkv", "mov"].includes(ext)) type = "video";
    else if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) type = "audio";
    else if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) type = "archive";
    else if (["pdf", "txt", "md", "csv"].includes(ext)) type = "text";
    else if (["js", "ts", "jsx", "tsx", "html", "css", "json", "rs", "go", "py"].includes(ext)) type = "code";
  }

  return (
    <div className="file-icon">
      {type === "folder" && <Folder />}
      {type === "image" && <ImageIcon />}
      {type === "video" && <Film />}
      {type === "audio" && <Music />}
      {type === "archive" && <Archive />}
      {type === "text" && <FileText />}
      {type === "code" && <FileCode />}
      {type === "default" && <FileIcon />}
    </div>
  );
}
