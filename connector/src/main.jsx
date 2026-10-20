import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/tokens.css";
import "../../src/styles/global.css";
import { ConnectionApp } from "./ConnectionApp/ConnectionApp.jsx";
createRoot(document.getElementById("root")).render(<ConnectionApp />);
