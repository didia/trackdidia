import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../../app/app-context";
import { isValidLlmBridgePort } from "../../domain/settings";
import {
  buildClaudeCodeCommand,
  buildLlmBridgeEndpoint,
  generateLlmBridgeToken,
} from "../../lib/llm-bridge/connection";
import { SectionCard } from "../SectionCard";
import { useSectionSave } from "./useSectionSave";

export const LlmBridgeSection = () => {
  const { t } = useTranslation("settings");
  const { settings, updateSettings, browserPreview, llmBridgeStatus } = useAppContext();
  const [enabledDraft, setEnabledDraft] = useState(settings.llmBridgeEnabled);
  const [portDraft, setPortDraft] = useState(String(settings.llmBridgePort));
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");

  const save = useSectionSave(async () => {
    const port = Number(portDraft.trim());
    if (!isValidLlmBridgePort(port)) {
      throw new Error(t("llmBridge.portInvalid"));
    }
    await updateSettings((current) => ({
      ...current,
      llmBridgeEnabled: enabledDraft,
      llmBridgePort: port,
      llmBridgeToken:
        enabledDraft && !current.llmBridgeToken ? generateLlmBridgeToken() : current.llmBridgeToken,
    }));
  });

  const regenerate = useSectionSave(async () => {
    await updateSettings((current) => ({ ...current, llmBridgeToken: generateLlmBridgeToken() }));
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(t("llmBridge.copied"));
    } catch {
      setCopyMessage("");
    }
  };

  const statusLabel = (() => {
    switch (llmBridgeStatus.state) {
      case "running":
        return t("llmBridge.status.running", { port: llmBridgeStatus.port });
      case "error":
        return t("llmBridge.status.error", { message: llmBridgeStatus.message });
      case "starting":
        return t("llmBridge.status.starting");
      default:
        return t("llmBridge.status.off");
    }
  })();
  const configured = settings.llmBridgeEnabled && settings.llmBridgeToken !== "";

  return (
    <SectionCard title={t("llmBridge.title")} subtitle={t("llmBridge.subtitle")}>
      {save.message ? <div className="banner">{save.message}</div> : null}
      {browserPreview ? <div className="banner">{t("llmBridge.browserPreview")}</div> : null}

      <div className="settings-form">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={enabledDraft}
            disabled={browserPreview}
            onChange={(event) => setEnabledDraft(event.target.checked)}
          />
          <span>{t("llmBridge.enable")}</span>
        </label>

        <label>
          <span>{t("llmBridge.port")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1024}
            max={65535}
            value={portDraft}
            disabled={browserPreview}
            onChange={(event) => setPortDraft(event.target.value)}
          />
        </label>

        <p role="status">{statusLabel}</p>

        {configured && !browserPreview ? (
          <>
            <label>
              <span>{t("llmBridge.endpoint")}</span>
              <input type="text" readOnly value={buildLlmBridgeEndpoint(settings.llmBridgePort)} />
            </label>
            <label>
              <span>{t("llmBridge.token")}</span>
              <input
                type={tokenVisible ? "text" : "password"}
                readOnly
                autoComplete="off"
                value={settings.llmBridgeToken}
              />
            </label>
            <div className="form-actions">
              <button
                className="button"
                type="button"
                onClick={() => setTokenVisible((visible) => !visible)}
              >
                {tokenVisible ? t("llmBridge.hide") : t("llmBridge.show")}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void copy(settings.llmBridgeToken)}
              >
                {t("llmBridge.copyToken")}
              </button>
              <button
                className="button"
                type="button"
                onClick={() =>
                  void copy(buildClaudeCodeCommand(settings.llmBridgePort, settings.llmBridgeToken))
                }
              >
                {t("llmBridge.copyCommand")}
              </button>
              <button
                className="button"
                type="button"
                disabled={regenerate.saving}
                onClick={() => void regenerate.run(t("llmBridge.saved"), t("llmBridge.saveError"))}
              >
                {t("llmBridge.regenerate")}
              </button>
            </div>
            <p className="muted" role="note">
              {copyMessage} {t("llmBridge.regenerateHint")}
            </p>
          </>
        ) : null}

        <p className="muted">{t("llmBridge.tokenLocalNotice")}</p>
        <p className="muted">{t("llmBridge.appMustRun")}</p>
      </div>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={browserPreview || save.saving}
          onClick={() => void save.run(t("llmBridge.saved"), t("llmBridge.saveError"))}
        >
          {save.saving ? t("llmBridge.saving") : t("llmBridge.save")}
        </button>
      </div>
    </SectionCard>
  );
};
