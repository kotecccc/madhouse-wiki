import { useEffect, useRef, useState } from "react";
import {
  PULL_THRESHOLD,
  WHEEL_MIN_EVENTS,
  resistedPull,
  accumulateWheel,
  beginWheelSequence,
} from "./pull-refresh-motion.js";

const WHEEL_RELEASE_DELAY = 220;

export function usePullRefresh({ regionRef, enabled, onRefresh }) {
  const [distance, setDistance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [touching, setTouching] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const region = regionRef.current;
    if (!enabled || !region) return undefined;
    let touch = null;
    let wheelDistance = 0;
    let wheelEvents = 0;
    let wheelTimer;
    let wheelSequence = null;
    let running = false;
    let alive = true;
    const atTop = () => {
      const scroller =
        getComputedStyle(region).display === "contents"
          ? document.scrollingElement
          : region;
      return (scroller?.scrollTop ?? 0) <= 0;
    };
    const eligible = (target) => {
      if (
        !(target instanceof Element) ||
        !region.contains(target) ||
        target.closest("dialog, [role='dialog']")
      )
        return false;
      for (
        let node = target;
        node && node !== region;
        node = node.parentElement
      ) {
        if (node.scrollHeight > node.clientHeight && node.scrollTop > 0)
          return false;
      }
      return true;
    };
    const finish = async (amount) => {
      setDistance(0);
      if (amount < PULL_THRESHOLD || running || !atTop()) return;
      running = true;
      setLoading(true);
      try {
        await refreshRef.current();
      } finally {
        running = false;
        if (alive) setLoading(false);
      }
    };
    const start = (event) => {
      if (
        running ||
        event.touches.length !== 1 ||
        !atTop() ||
        !eligible(event.target)
      )
        return;
      setTouching(true);
      touch = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        amount: 0,
        direction: null,
      };
    };
    const move = (event) => {
      if (!touch || event.touches.length !== 1) return;
      if (touch.triggered) {
        if (event.cancelable) event.preventDefault();
        return;
      }
      const dx = event.touches[0].clientX - touch.x;
      const dy = event.touches[0].clientY - touch.y;
      if (!touch.direction && Math.max(Math.abs(dx), Math.abs(dy)) > 6)
        touch.direction =
          dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.3 ? "pull" : "other";
      if (touch.direction !== "pull" || !atTop()) return;
      if (event.cancelable) event.preventDefault();
      touch.amount = resistedPull(dy);
      setDistance(touch.amount);
      if (touch.amount >= PULL_THRESHOLD) {
        touch.triggered = true;
        setTouching(false);
        void finish(touch.amount);
      }
    };
    const end = (event) => {
      if (!touch) return;
      const amount =
        touch.triggered ||
        event.type === "touchcancel" ||
        event.touches.length > 0
          ? 0
          : touch.amount;
      touch = null;
      setTouching(false);
      void finish(amount);
    };
    const wheel = (event) => {
      if (
        event.ctrlKey ||
        !eligible(event.target) ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      )
        return;
      wheelSequence = beginWheelSequence(wheelSequence, atTop());
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelSequence = null;
        wheelDistance = 0;
        wheelEvents = 0;
        setDistance(0);
      }, WHEEL_RELEASE_DELAY);
      if (
        running ||
        wheelSequence.triggered ||
        !wheelSequence.eligible ||
        !atTop()
      )
        return;
      if (event.deltaY >= 0) {
        wheelSequence.eligible = false;
        wheelDistance = 0;
        wheelEvents = 0;
        setDistance(0);
        return;
      }
      if (event.cancelable) event.preventDefault();
      wheelDistance = accumulateWheel(
        wheelDistance,
        event.deltaY,
        event.deltaMode,
        region.clientHeight || window.innerHeight,
      );
      wheelEvents += 1;
      const amount = resistedPull(wheelDistance * 0.7);
      setDistance(amount);
      if (wheelEvents >= WHEEL_MIN_EVENTS && amount >= PULL_THRESHOLD) {
        wheelSequence.triggered = true;
        void finish(amount);
      }
    };
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    document.addEventListener("wheel", wheel, { passive: false });
    return () => {
      alive = false;
      clearTimeout(wheelTimer);
      setDistance(0);
      setTouching(false);
      setLoading(false);
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      document.removeEventListener("wheel", wheel);
    };
  }, [enabled, regionRef]);
  return {
    progress: Math.min(1, distance / PULL_THRESHOLD),
    loading,
    touching,
  };
}
