import { BorderLoader } from "../BorderLoader/BorderLoader.jsx";
import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { refreshModal } from "./pull-refresh.js";
import { pushPage, hasPage, removePage } from "./page-history.js";
import {
  PageHostContext,
  registerPage,
  subscribePages,
  getPages,
} from "./page-context.js";
import { Title } from "../Title/Title.jsx";
import { Button } from "../Button/Button.jsx";
import "./Modal.css";

export function Modal({
  title,
  description,
  titleId,
  onClose,
  children,
  contentBottom,
  footer,
  footerNote,
  footerStart,
  className = "",
  contentScrollable = true,
  contentVariant = "default",
  contentAlignment = "start",
  visible = true,
  loading = false,
  onRefresh,
  refreshKey,
  hideHeader = false,
  pageKind,
  pageUrl,
}) {
  const generatedId = useId();
  const id = titleId || generatedId;
  const host = useContext(PageHostContext);
  const pages = useSyncExternalStore(subscribePages, getPages, getPages);
  const [pullLoading, setPullLoading] = useState(false);
  const refreshRef = useRef(onRefresh);
  const runRefreshRef = useRef(null);
  refreshRef.current = onRefresh;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pageId = useRef(null);
  const pageUrlRef = useRef(pageUrl);
  pageUrlRef.current = pageUrl;
  const pageRef = useRef(null);
  useEffect(() => {
    if (!visible || !host) return undefined;
    const previous = document.activeElement;
    const region = host.closest("[data-page-scroll]");
    const scroller =
      region && getComputedStyle(region).display !== "contents"
        ? region
        : document.scrollingElement;
    const previousScroll = scroller?.scrollTop ?? 0;
    const id = pushPage(window.history, pageUrlRef.current, window.location);
    pageId.current = id;
    const unregister = registerPage(generatedId, () => closeRef.current(), {
      kind: pageKind,
      canRefresh: () => Boolean(refreshRef.current),
      refresh: () => runRefreshRef.current?.(),
      back: () => {
        if (hasPage(window.history.state, id)) window.history.back();
        else closeRef.current();
      },
    });
    scroller?.scrollTo({ top: 0, behavior: "instant" });
    pageRef.current?.focus({ preventScroll: true });
    const onPop = (event) => {
      if (!hasPage(event.state, id)) closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      unregister();
      removePage(window.history, id);
      if (pageId.current === id) pageId.current = null;
      scroller?.scrollTo({ top: previousScroll, behavior: "instant" });
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [visible, host, generatedId, pageKind]);
  useEffect(() => {
    if (
      visible &&
      pageUrl &&
      pageId.current &&
      hasPage(window.history.state, pageId.current) &&
      window.location.pathname !== pageUrl
    )
      window.history.replaceState(
        window.history.state,
        "",
        `${pageUrl}${window.location.search}`,
      );
  }, [visible, pageUrl]);
  function closePage() {
    if (pageId.current && hasPage(window.history.state, pageId.current))
      window.history.back();
    else onClose();
  }
  async function runRefresh() {
    if (!refreshRef.current || loadingRef.current) return;
    try {
      await refreshModal(refreshKey || title, async () => {
        setPullLoading(true);
        try {
          await refreshRef.current();
        } finally {
          setPullLoading(false);
        }
      });
    } catch {
      // The owning feature reports its own refresh errors.
    }
  }
  runRefreshRef.current = runRefresh;
  if (!visible) return null;
  const page = (
    <section
      ref={pageRef}
      tabIndex={-1}
      hidden={Boolean(host && pages.length && pages.at(-1).id !== generatedId)}
      className={`shared-modal${footer === false ? " shared-modal--no-footer" : ""}${contentVariant === "inset" ? " shared-modal--inset" : ""} ${className}`.trim()}
      aria-labelledby={id}
      aria-busy={loading || undefined}
    >
      <>
        {hideHeader ? (
          <h2 id={id} className="sr-only">
            {title}
          </h2>
        ) : (
          <header className="shared-modal-heading">
            <Button
              icon="arrow-left"
              iconOnly
              aria-label="Назад"
              onClick={closePage}
            />
            <div className="shared-modal-heading-copy">
              <Title as="h2" id={id} className="shared-modal-title">
                {title}
              </Title>
              {description && (
                <p className="shared-modal-description">{description}</p>
              )}
            </div>
            {(loading || pullLoading) && (
              <span className="shared-modal-heading-loader">
                <BorderLoader />
              </span>
            )}
          </header>
        )}
        <div
          tabIndex={onRefresh ? 0 : undefined}
          aria-keyshortcuts={onRefresh ? "R" : undefined}
          onKeyDown={(event) => {
            if (
              onRefresh &&
              event.key === "r" &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.target.closest("input, textarea, select, button, a")
            ) {
              event.preventDefault();
              void runRefresh();
            }
          }}
          className={`shared-modal-content${
            contentVariant === "default"
              ? ""
              : ` shared-modal-content--${contentVariant}`
          }${contentAlignment === "center" ? " shared-modal-content--center" : ""}${contentScrollable ? "" : " shared-modal-content--unscrollable"}`}
        >
          {contentAlignment === "center" ? (
            <div className="shared-modal-content-inner">{children}</div>
          ) : (
            children
          )}
          {contentBottom != null && (
            <div className="shared-modal-content-bottom">{contentBottom}</div>
          )}
        </div>
        {footer === false ? null : footerNote != null ? (
          <footer
            className={`shared-modal-footer shared-modal-footer--with-note${footerStart ? " shared-modal-footer--split" : ""}`}
          >
            {footerStart}
            <p
              className={`shared-modal-footer-note${footerStart ? " shared-modal-footer-note--center" : ""}`}
            >
              {footerNote}
            </p>
            {footer || <Button onClick={closePage}>Назад</Button>}
          </footer>
        ) : footer ? (
          <footer
            className={`shared-modal-footer${footerStart ? " shared-modal-footer--spread" : ""}`}
          >
            {footerStart}
            {footer}
          </footer>
        ) : (
          <footer className="shared-modal-footer shared-modal-mobile-footer">
            <Button onClick={closePage}>Назад</Button>
          </footer>
        )}
      </>
    </section>
  );
  return host ? createPortal(page, host) : page;
}
