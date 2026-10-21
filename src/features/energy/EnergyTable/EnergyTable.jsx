import { useEffect, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { fmt, fmtEnergy } from "../../../lib/format.js";
import { getSessionJson } from "../../../../shared/session-api.js";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { energyTableRows, energyTableSourceDate } from "./energy-table-data.js";
import "./EnergyTable.css";

const dayFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 1,
});

function formatDays(value) {
  const rounded = Math.round(value * 10) / 10;
  const unit = Number.isInteger(rounded) ? "дней" : "дня";
  return `~${dayFormatter.format(rounded)} ${unit}`;
}

function formatCoupons(value) {
  return fmt(Math.round(value * 10) / 10);
}

export function EnergyTable() {
  const [profileLimit, setProfileLimit] = useState(null);
  const [profileStatus, setProfileStatus] = useState("reference");

  useEffect(() => {
    let controller;
    const loadProfileLimit = async () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      if (readSession().status !== "ready") {
        setProfileLimit(null);
        setProfileStatus("reference");
        return;
      }

      setProfileLimit(null);
      setProfileStatus("loading");
      try {
        const profile = await getSessionJson("/api/me", { signal, fresh: true });
        const maxEnergy = profile?.energy?.max;
        if (!Number.isSafeInteger(maxEnergy) || maxEnergy <= 0)
          throw new Error("Energy limit unavailable");
        if (!signal.aborted) {
          setProfileLimit(maxEnergy);
          setProfileStatus("profile");
        }
      } catch {
        if (!signal.aborted) {
          setProfileLimit(null);
          setProfileStatus("unavailable");
        }
      }
    };

    loadProfileLimit();
    const unsubscribe = subscribeSession(loadProfileLimit);
    return () => {
      controller?.abort();
      unsubscribe();
    };
  }, []);

  return (
    <ContentSection
      className="energy-table-section"
      id="energy"
      aria-labelledby="energy-title"
    >
      <BaseCard className="energy-table-card">
        <div className="energy-table-heading">
          <Title as="h2" id="energy-title">
            Энергия работ
          </Title>
          <p className="energy-table-subtitle">
            Оценка купюр и времени для указанного количества проходок.
          </p>
        </div>

        <div
          className="energy-table-scroll"
          role="region"
          aria-label="Таблица энергии работ; прокручивается по горизонтали"
          tabIndex="0"
        >
          <table className="energy-table">
            <thead>
              <tr>
                <th scope="col">Корпус</th>
                <th scope="col">🧠 Энергии на одну проходку</th>
                <th scope="col">Лимит энергии игрока</th>
                <th scope="col">Купюр на 1 выполнение</th>
                <th scope="col">Кол-во раз</th>
                <th scope="col">Всего купюр</th>
                <th scope="col">Время выполнения</th>
              </tr>
            </thead>
            <tbody>
              {energyTableRows.map((row) => {
                const limit = profileLimit ?? row.referenceLimit;
                const personalized = profileLimit != null;
                const estimatedCouponsPerRun = row.energy / (limit * 0.1);
                const couponsPerRun = personalized
                  ? estimatedCouponsPerRun
                  : row.couponsPerRun;
                const totalCoupons = personalized
                  ? Math.round(estimatedCouponsPerRun * row.runs)
                  : row.totalCoupons;
                const days = (row.energy * row.runs * 2) / (60 * 24);

                return (
                  <tr key={row.code}>
                    <th scope="row">{row.code}</th>
                    <td>{fmtEnergy(row.energy)}</td>
                    <td>
                      {fmtEnergy(limit)}
                      {profileStatus === "loading" && !profileLimit ? "…" : ""}
                    </td>
                    <td>{formatCoupons(couponsPerRun)}</td>
                    <td>{fmt(row.runs)}</td>
                    <td>{fmt(totalCoupons)}</td>
                    <td>{formatDays(days)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="energy-table-note">
          {profileStatus === "profile"
            ? "Лимит взят из авторизованного профиля; купюры пересчитаны по оценке 10% лимита на купюру."
            : profileStatus === "unavailable"
              ? "Не удалось получить лимит из профиля; показаны лимиты исходной таблицы."
              : profileStatus === "loading"
                ? "Загружаем лимит энергии профиля…"
                : "Для авторизованного профиля лимит и расчёт купюр будут персональными."}
        </p>
        <p className="energy-table-provenance">
          Значения проходок и количества выполнений — снимок публикации от {energyTableSourceDate}; состав проходки не подтверждён для всех корпусов. Время оценочное, без учёта энергии за повышение уровня.
        </p>
      </BaseCard>
    </ContentSection>
  );
}
