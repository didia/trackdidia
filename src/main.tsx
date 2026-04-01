import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installDebugInstrumentation, logDebug } from "./lib/debug";
import "./styles.css";

installDebugInstrumentation();
logDebug("info", "app.main", "Initialisation du rendu principal");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
