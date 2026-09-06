import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiveCodeCard } from "./App";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("receive code submission", () => {
  function form(onSubmit: (code: string) => void) {
    function Harness() {
      const [value, onChange] = useState("");
      return <ReceiveCodeCard value={value} onChange={onChange} onSubmit={onSubmit} onClose={() => {}} hasError={false} />;
    }
    return render(<Harness />);
  }

  it("submits all six characters immediately after typing the last one", () => {
    const submit = vi.fn();
    const ui = form(submit);
    const inputs = ui.getAllByRole("textbox");
    [..."ABCDE"].forEach((char, index) => fireEvent.change(inputs[index], { target: { value: char } }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(inputs[5], { target: { value: "f" } });
    expect(submit).toHaveBeenCalledExactlyOnceWith("ABCDEF");
  });

  it("submits a sanitized pasted code without triggering global paste handling", () => {
    const submit = vi.fn();
    const globalPaste = vi.fn();
    window.addEventListener("paste", globalPaste);
    try {
      const ui = form(submit);
      fireEvent.paste(ui.getAllByRole("textbox")[0], { clipboardData: { getData: () => "abc def" } });
      expect(submit).toHaveBeenCalledExactlyOnceWith("ABCDEF");
      expect(globalPaste).not.toHaveBeenCalled();
      expect(ui.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value).join("")).toBe("ABCDEF");
    } finally {
      window.removeEventListener("paste", globalPaste);
    }
  });
});
