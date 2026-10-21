import { useState } from "react";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { tokenBookmarklet } from "./token-bookmarklet.js";
import "./TokenBookmarklet.css";

export function TokenBookmarklet() {
  const [copyState, setCopyState] = useState("");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(tokenBookmarklet);
      setCopyState("Код скопирован");
    } catch {
      setCopyState("Не удалось скопировать код. Проверьте доступ к буферу обмена и повторите.");
    }
  }

  return (
    <div className="token-bookmarklet">
      <Button variant="secondary" onClick={copyCode}>
        Скопировать код закладки
      </Button>
      {copyState && <p className="token-bookmarklet-status" role="status">{copyState}</p>}
    </div>
  );
}
