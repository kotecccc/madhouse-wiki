import { useRef } from "react";
import "./OtpCodeInput.css";

const CODE_LENGTH = 5;

function digitsOnly(value) {
  return String(value ?? "")
    .replace(/[^0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

export function OtpCodeInput({ value = "", onChange, disabled = false }) {
  const inputs = useRef([]);
  const digits = Array.from(
    { length: CODE_LENGTH },
    (_, index) => digitsOnly(value)[index] || "",
  );

  const update = (start, inserted) => {
    const next = digits.slice();
    const clean = digitsOnly(inserted);
    for (
      let index = 0;
      index < clean.length && start + index < CODE_LENGTH;
      index++
    )
      next[start + index] = clean[index];
    onChange(next.join(""));
    const focusIndex = Math.min(
      start + Math.max(clean.length, 1),
      CODE_LENGTH - 1,
    );
    inputs.current[focusIndex]?.focus();
  };

  const handleChange = (index, rawValue) => {
    const clean = digitsOnly(rawValue);
    if (clean.length > 1) {
      update(clean.length === CODE_LENGTH ? 0 : index, clean);
      return;
    }
    const next = digits.slice();
    next[index] = clean;
    onChange(next.join(""));
    if (clean && index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  const handleKeyDown = (event, index) => {
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    } else if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = digits.slice();
      next[index - 1] = "";
      onChange(next.join(""));
      inputs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (event, index) => {
    event.preventDefault();
    const pasted = digitsOnly(event.clipboardData.getData("text"));
    update(pasted.length === CODE_LENGTH ? 0 : index, pasted);
  };

  return (
    <div className="otp-code-input" role="group" aria-label="Код Telegram">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            inputs.current[index] = node;
          }}
          className="otp-code-input__cell"
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          aria-label={`Цифра ${index + 1} из ${CODE_LENGTH} кода Telegram`}
          maxLength={CODE_LENGTH}
          value={digit}
          onFocus={(event) => event.currentTarget.select()}
          disabled={disabled}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          onPaste={(event) => handlePaste(event, index)}
        />
      ))}
    </div>
  );
}
