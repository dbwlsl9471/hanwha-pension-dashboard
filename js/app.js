/* 한화투자증권 퇴직연금 공시 비교 대시보드 */
(function () {
  const COMPANY = "한화투자증권";
  const EDITOR_PASS = "hanwha-edit"; // 편집자 전용 — 배포 전 변경 권장
  const LS_DATA = "hanwha_pension_store_v1";
  const LS_EDIT = "hanwha_pension_editor";
  const LS_COMP = "hanwha_pension_competitors";
  const MAX_COMPETITORS = 6;
  let draftCompetitors = [];

  const state = {
    data: null,
    page: "summary",
    editor: false,
    charts: {},
    filters: {
      baseQ: null,
      cmpQ: null,
      plan: "IRP",
      type: "원리금보장(통합)",
      period: "1",
      avgMode: "weighted",
      minAum: 0,
      sector: "증권",
      risk: "초저위험",
      doPeriod: "1y",
      feeYear: null,
      feeCmpYear: null,
      feeSector: "증권",
      feePlan: "DC",
      competitors: [],
    },
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2600);
  }

  function fmt(n, d = 2) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("ko-KR", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }
  function fmtInt(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Math.round(n).toLocaleString("ko-KR");
  }
  /** 적립금(억): 1조(10,000억) 이상만 조, 그 미만은 6,470억 */
  function fmtAum(n, d = 2) {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n;
    if (Math.abs(v) >= 10000) {
      return (
        (v / 10000).toLocaleString("ko-KR", {
          minimumFractionDigits: d,
          maximumFractionDigits: d,
        }) + "조"
      );
    }
    return Math.round(v).toLocaleString("ko-KR") + "억";
  }
  function fmtPct(n) {
    return n == null ? "—" : fmt(n) + "%";
  }
  /** 순위 표기: 12위/14개 */
  function fmtRank(rank, n) {
    if (rank == null || n == null) return "—";
    return `${rank}위/${n}개`;
  }
  function fmtPp(n) {
    if (n == null) return "—";
    const s = (n >= 0 ? "+" : "") + fmt(n);
    return s + "%p";
  }
  function fmtPctChg(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (n >= 0 ? "+" : "") + fmt(n) + "%";
  }
  function valCls(n) {
    if (n == null || Number.isNaN(n) || Math.abs(n) < 1e-9) return "";
    return n > 0 ? "val-up" : "val-down";
  }
  function kpiLine(label, valueHtml, cls) {
    return `<div class="kpi-line"><span class="k">${label}</span><span class="v ${cls || ""}">${valueHtml}</span></div>`;
  }
  function sumPlanAum(indexed, plan, sectorFilter) {
    let s = 0;
    for (const e of indexed.values()) {
      if (sectorFilter && sectorFilter !== "전체" && e.sector !== sectorFilter) continue;
      s += Calc.totalAum(e, plan) || 0;
    }
    return s;
  }
  function sumAllPlansAum(indexed, sectorFilter) {
    return (
      sumPlanAum(indexed, "DB", sectorFilter) +
      sumPlanAum(indexed, "DC", sectorFilter) +
      sumPlanAum(indexed, "IRP", sectorFilter)
    );
  }
  function aumRankOf(indexed, plan, sector, name) {
    const list = [];
    for (const e of indexed.values()) {
      if (sector && sector !== "전체" && e.sector !== sector) continue;
      const a = Calc.totalAum(e, plan);
      if (a == null) continue;
      list.push({ name: e.name, aum: a });
    }
    list.sort((a, b) => b.aum - a.aum);
    Calc.assignCompetitionRanks(list, (row) => row.aum);
    const hit = list.find((r) => r.name === name);
    if (!hit) return { rank: null, n: list.length };
    return { rank: hit.rank, n: list.length, aum: hit.aum };
  }

  function dataKeys(kind) {
    const bag = (state.data && state.data[kind]) || {};
    const keys = Object.keys(bag).filter((k) => Array.isArray(bag[k]) && bag[k].length > 0);
    if (kind === "fees") return keys.sort();
    return Calc.sortQuarters(keys);
  }

  /** 선택 연도에 수수료 데이터가 없으면 최신 공시 연도 */
  function feesYearFor(year) {
    const keys = dataKeys("fees");
    if (!keys.length) return null;
    if (year && keys.includes(year)) return year;
    if (year) {
      const earlier = keys.filter((k) => k <= year);
      if (earlier.length) return earlier[earlier.length - 1];
    }
    return keys[keys.length - 1];
  }

  function formatPeriodLabel(q) {
    if (!q) return "—";
    if (/^\d{4}Q[1-4]$/.test(q)) return q.replace("Q", "년 ") + "분기";
    return q + (String(q).length === 4 ? "년" : "");
  }

  function isQuarterKey(q) {
    return typeof q === "string" && /^\d{4}Q[1-4]$/.test(q);
  }

  function periodKindForPage() {
    return state.page === "defaults" ? "defaults" : "returns";
  }

  function hasPeriodData(kind, key) {
    if (!key) return false;
    const rows = ((state.data && state.data[kind]) || {})[key];
    return Array.isArray(rows) && rows.length > 0;
  }

  /** 공시분 + 저장키 + 최신 다음 분기(분기말 선택용) */
  function quarterSelectKeys() {
    const kind = periodKindForPage();
    const withData = dataKeys(kind);
    const stored = Object.keys((state.data && state.data[kind]) || {}).filter(isQuarterKey);
    let qs = Calc.sortQuarters([...new Set([...withData, ...stored])]);
    if (!qs.length) {
      const fallback = kind === "defaults" ? dataKeys("returns") : dataKeys("defaults");
      qs = [...fallback];
    }
    if (qs.length) {
      const nxt = Calc.nextQuarter(qs[qs.length - 1]);
      if (nxt) qs = Calc.sortQuarters([...new Set([...qs, nxt])]);
    }
    const f = state.filters;
    [f.baseQ, f.cmpQ].forEach((q) => {
      if (isQuarterKey(q) && !qs.includes(q)) qs = Calc.sortQuarters([...qs, q]);
    });
    return qs;
  }

  function quarterOptionLabel(q, kind) {
    const base = q.replace("Q", "년 ") + "분기";
    return hasPeriodData(kind, q) ? base : `${base} (공시 없음)`;
  }

  /** 페이지 진입 시: 해당 화면 데이터가 있는 가장 최근 시점 */
  function applyLatestPeriodForPage() {
    const f = state.filters;
    if (state.page === "data") return;
    if (state.page === "fees") {
      const yKeys = dataKeys("fees");
      f.feeYear = yKeys[yKeys.length - 1] || null;
      f.feeCmpYear = yKeys.length > 1 ? yKeys[yKeys.length - 2] : null;
      return;
    }
    const withData = dataKeys(periodKindForPage());
    if (!withData.length) return;
    f.baseQ = withData[withData.length - 1];
    f.cmpQ = withData.length > 1 ? withData[withData.length - 2] : null;
  }

  /** 최초/무효 값만 보정. 공시 없는 다음 분기 선택은 유지 */
  function ensureLatestPeriodFilters() {
    const f = state.filters;
    if (state.page === "fees") {
      const yKeys = dataKeys("fees");
      if (!f.feeYear || (yKeys.length && !yKeys.includes(f.feeYear))) {
        f.feeYear = yKeys[yKeys.length - 1] || null;
      }
      if (f.feeCmpYear && yKeys.length && !yKeys.includes(f.feeCmpYear)) {
        const yi = yKeys.indexOf(f.feeYear);
        f.feeCmpYear = yi > 0 ? yKeys[yi - 1] : yKeys.length > 1 ? yKeys[yKeys.length - 2] : null;
      }
      return;
    }
    const opts = quarterSelectKeys();
    const withData = dataKeys(periodKindForPage());
    if (!f.baseQ || (!opts.includes(f.baseQ) && !isQuarterKey(f.baseQ))) {
      f.baseQ = withData[withData.length - 1] || opts[opts.length - 1] || null;
    }
    if (f.cmpQ && !isQuarterKey(f.cmpQ)) f.cmpQ = null;
  }

  /** @returns {boolean} 기준 분기 데이터 있으면 true */
  function applyPeriodAvailability() {
    const page = state.page;
    const el = $(`#page-${page}`);
    if (!el || page === "fees" || page === "data") {
      if (el) {
        el.classList.remove("no-period-data");
        el.querySelector(".empty-period-banner")?.remove();
      }
      return true;
    }
    const kind = periodKindForPage();
    const q = state.filters.baseQ;
    const has = hasPeriodData(kind, q);
    el.classList.toggle("no-period-data", !has);
    let banner = el.querySelector(".empty-period-banner");
    if (!has) {
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "empty-period-banner";
        const head = el.querySelector(".page-head");
        if (head) head.after(banner);
        else el.prepend(banner);
      }
      banner.innerHTML =
        `<strong>해당 시점 공시 데이터 없음</strong>` +
        `<span>${formatPeriodLabel(q)} 공시가 아직 등록되지 않았습니다. 다른 분기를 선택해 주세요.</span>`;
      return false;
    }
    if (banner) banner.remove();
    return true;
  }

  function cmpPeriodNote(kind, cmpQ) {
    if (!cmpQ) return "비교분기 없음";
    if (!hasPeriodData(kind, cmpQ)) return "해당 시점 공시 데이터 없음";
    return formatPeriodLabel(cmpQ);
  }

  function defaultRetOf(name, quarter, risk, doPeriod) {
    if (!quarter) return null;
    const list = Calc.aggregateDefaults(state.data.defaults[quarter] || [], risk, doPeriod);
    const hit = list.find((r) => r.name === name);
    return hit ? hit.ret : null;
  }

  function defaultRetAggregate(quarter, risk, doPeriod, sectorOrFn) {
    if (!quarter) return null;
    let list = Calc.aggregateDefaults(state.data.defaults[quarter] || [], risk, doPeriod);
    if (typeof sectorOrFn === "function") list = list.filter(sectorOrFn);
    else if (sectorOrFn && sectorOrFn !== "전체") list = list.filter((r) => r.sector === sectorOrFn);
    if (!list.length) return null;
    const den = list.reduce((a, b) => a + (b.aum || 0), 0);
    if (!den) return list.reduce((a, b) => a + b.ret, 0) / list.length;
    return list.reduce((a, b) => a + b.ret * (b.aum || 0), 0) / den;
  }

  function feeRowsHaveSplit(rows) {
    return (rows || []).some(
      (r) =>
        (r.DB && r.DB.ops != null) ||
        (r.DC && r.DC.ops != null) ||
        (r.IRP && r.IRP.ops != null)
    );
  }

  /** 같은 연도면 운용/자산 분리가 있는 쪽 우선 */
  function pickFeeYearRows(deployRows, localRows) {
    if (!localRows) return deployRows;
    if (!deployRows) return localRows;
    const dSplit = feeRowsHaveSplit(deployRows);
    const lSplit = feeRowsHaveSplit(localRows);
    if (dSplit && !lSplit) return deployRows;
    return localRows;
  }

  /** 배포본(APP_DATA) + 로컬 업로드를 분기/연도 키 단위로 병합 (로컬이 배포본을 통째로 가리지 않음) */
  function mergeDataStores(deploy, local) {
    const out = JSON.parse(JSON.stringify(deploy || {}));
    out.returns = out.returns || {};
    out.defaults = out.defaults || {};
    out.fees = out.fees || {};
    out.sources = out.sources || {};
    out.meta = out.meta || {};
    if (!local) {
      state.dataOrigin = "deploy";
      return out;
    }
    out.returns = { ...(deploy.returns || {}), ...(local.returns || {}) };
    out.defaults = { ...(deploy.defaults || {}), ...(local.defaults || {}) };
    const feeKeys = new Set([
      ...Object.keys(deploy.fees || {}),
      ...Object.keys(local.fees || {}),
    ]);
    out.fees = {};
    feeKeys.forEach((y) => {
      out.fees[y] = pickFeeYearRows(
        deploy.fees && deploy.fees[y],
        local.fees && local.fees[y]
      );
    });
    out.sources = { ...(deploy.sources || {}), ...(local.sources || {}) };
    out.meta = { ...(deploy.meta || {}), ...(local.meta || {}) };
    const dAt = deploy.meta && deploy.meta.updatedAt;
    const lAt = local.meta && local.meta.updatedAt;
    if (dAt && lAt) out.meta.updatedAt = dAt >= lAt ? dAt : lAt;
    else out.meta.updatedAt = lAt || dAt || out.meta.updatedAt;
    state.dataOrigin = "merged";
    return out;
  }

  function formatUpdatedAt(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function updateHeaderMeta() {
    const el = $("#dataMetaShort");
    if (!el) return;
    const at = formatUpdatedAt(state.data && state.data.meta && state.data.meta.updatedAt);
    const origin =
      state.dataOrigin === "merged"
        ? "로컬+배포"
        : state.dataOrigin === "local"
        ? "로컬"
        : "배포";
    el.textContent = at ? `갱신 ${at} · ${origin}` : `공시 데이터 · ${origin}`;
    el.title =
      state.dataOrigin === "merged"
        ? "브라우저에 올린 데이터가 배포본과 병합되어 표시됩니다. 배포본만 보려면 데이터 관리 → 로컬 저장 초기화."
        : "현재 화면에 로드된 공시 데이터 기준입니다.";
  }

  function loadData() {
    const deploy = window.APP_DATA
      ? JSON.parse(JSON.stringify(window.APP_DATA))
      : {
          meta: { company: COMPANY, competitors_default: [] },
          returns: {},
          defaults: {},
          fees: {},
          sources: {},
        };
    let local = null;
    try {
      const raw = localStorage.getItem(LS_DATA);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.returns || parsed.defaults || parsed.fees)) local = parsed;
      }
    } catch (e) {
      console.warn(e);
    }
    const base = mergeDataStores(deploy, local);
    state.data = base;
    try {
      const saved = JSON.parse(localStorage.getItem(LS_COMP) || "[]");
      if (Array.isArray(saved) && saved.length) {
        state.filters.competitors = saved.slice(0, MAX_COMPETITORS);
      }
    } catch (e) { /* ignore */ }
    if (!state.filters.competitors.length) {
      state.filters.competitors = (base.meta.competitors_default || []).slice(0, MAX_COMPETITORS);
    }
    // 항상 데이터가 있는 가장 최신 분기·연도를 기본값으로
    const qs = dataKeys("returns");
    state.filters.baseQ = qs[qs.length - 1] || null;
    if (qs.length > 1) {
      state.filters.cmpQ = qs[qs.length - 2];
    } else {
      state.filters.cmpQ = null;
    }
    const ys = dataKeys("fees");
    state.filters.feeYear = ys[ys.length - 1] || null;
    state.filters.feeCmpYear = ys.length > 1 ? ys[ys.length - 2] : null;
    updateHeaderMeta();
  }

  function persistData() {
    state.data.meta.updatedAt = new Date().toISOString();
    state.dataOrigin = "merged";
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(state.data));
    } catch (e) {
      console.warn(e);
      toast("로컬 저장 용량이 부족합니다. 배포용 data-store.js로 받거나 일부 분기를 삭제하세요.");
    }
    updateHeaderMeta();
  }

  function isEditor() {
    return state.editor || localStorage.getItem(LS_EDIT) === "1";
  }

  function setEditor(on) {
    state.editor = on;
    localStorage.setItem(LS_EDIT, on ? "1" : "0");
    $("#editorBadge").style.display = on ? "inline-flex" : "none";
    $("#btnEditor").textContent = on ? "관리자 모드 종료" : "관리자 로그인";
    const navData = $("#navData");
    if (navData) navData.style.display = on ? "" : "none";
    if (!on && state.page === "data") {
      state.page = "summary";
      renderPage();
    } else if (state.page === "data") {
      renderDataPage();
    }
  }

  /* ---------- filters UI ---------- */
  function fillSelect(sel, items, value) {
    sel.innerHTML = items
      .map(([v, t]) => `<option value="${v}" ${v === value ? "selected" : ""}>${t}</option>`)
      .join("");
  }

  function syncFilterControls() {
    const f = state.filters;
    ensureLatestPeriodFilters();
    const qKind = periodKindForPage();
    const qs = quarterSelectKeys();
    const qOpts = qs.map((q) => [q, quarterOptionLabel(q, qKind)]);
    fillSelect($("#fBaseQ"), qOpts, f.baseQ);
    fillSelect($("#fCmpQ"), [["", "없음"], ...qOpts], f.cmpQ || "");
    fillSelect($("#fPlan"), [["DB", "DB"], ["DC", "DC"], ["IRP", "IRP"]], f.plan);
    fillSelect(
      $("#fType"),
      [
        ["예금성", "예금성"],
        ["시장성", "시장성"],
        ["실적배당형", "실적배당형"],
        ["원리금보장(통합)", "원리금보장(통합)"],
      ],
      f.type
    );
    fillSelect(
      $("#fPeriod"),
      [
        ["1", "1년"],
        ["3", "3년 (연환산)"],
        ["5", "5년 (연환산)"],
        ["7", "7년 (연환산)"],
        ["10", "10년 (연환산)"],
      ],
      f.period
    );
    fillSelect(
      $("#fAvg"),
      [
        ["weighted", "적립금 가중"],
        ["simple", "단순"],
      ],
      f.avgMode
    );
    $("#fMinAum").value = f.minAum || 0;
    fillSelect(
      $("#fSector"),
      [
        ["전체", "전체"],
        ["증권", "증권"],
        ["은행", "은행"],
        ["생보", "생보"],
        ["손보", "손보"],
      ],
      f.sector
    );
    fillSelect(
      $("#fRisk"),
      [
        ["초저위험", "초저위험"],
        ["저위험", "저위험"],
        ["중위험", "중위험"],
        ["고위험", "고위험"],
      ],
      f.risk
    );
    fillSelect(
      $("#fDoPeriod"),
      [
        ["1m", "1개월"],
        ["3m", "3개월"],
        ["6m", "6개월"],
        ["1y", "1년"],
        ["3y", "3년"],
      ],
      f.doPeriod
    );
    const feeYs = dataKeys("fees");
    const ys = feeYs.length ? feeYs : Object.keys(state.data.fees || {}).sort();
    fillSelect(
      $("#fFeeYear"),
      ys.map((y) => [y, y + "년"]),
      f.feeYear
    );
    fillSelect(
      $("#fFeeCmpYear"),
      [["", "없음"], ...ys.map((y) => [y, y + "년"])],
      f.feeCmpYear || ""
    );
    fillSelect(
      $("#fFeeSector"),
      [
        ["전체", "전체"],
        ["증권", "증권"],
        ["은행", "은행"],
        ["생보", "생보"],
        ["손보", "손보"],
      ],
      f.feeSector
    );
    fillSelect($("#fFeePlan"), [["DB", "DB"], ["DC", "DC"], ["IRP", "IRP"]], f.feePlan);
    applyFilterVisibility();
  }

  function saveCompetitors() {
    localStorage.setItem(LS_COMP, JSON.stringify(state.filters.competitors || []));
  }

  function listProvidersBySector() {
    const f = state.filters;
    const bySector = { 증권: [], 은행: [], 생보: [], 손보: [], 기타: [] };
    const seen = new Set();
    const q = hasPeriodData("returns", f.baseQ)
      ? f.baseQ
      : dataKeys("returns").slice(-1)[0] || f.baseQ;
    const rows = state.data.returns[q] || [];
    rows.forEach((r) => {
      if (!r.name || r.name === COMPANY || seen.has(r.name)) return;
      seen.add(r.name);
      const sec = r.sector || "기타";
      if (!bySector[sec]) bySector[sec] = [];
      bySector[sec].push(r.name);
    });
    Object.keys(bySector).forEach((k) => {
      bySector[k].sort((a, b) => a.localeCompare(b, "ko"));
    });
    return bySector;
  }

  function updateCompTriggerLabel() {
    const btn = $("#btnCompPick");
    if (!btn) return;
    btn.textContent = `경쟁사 ${(state.filters.competitors || []).length}개`;
  }

  function updateCompModalTitle() {
    const t = $("#compModalTitle");
    if (t) t.textContent = `경쟁사 그룹 (${draftCompetitors.length}/${MAX_COMPETITORS})`;
  }

  function openCompModal() {
    draftCompetitors = [...(state.filters.competitors || [])];
    renderCompPicker();
    $("#modalComp")?.classList.add("show");
  }

  function closeCompModal() {
    $("#modalComp")?.classList.remove("show");
  }

  function refreshCompPage() {
    try {
      if (state.page === "summary") renderSummary();
      else if (state.page === "sector") renderSector();
      else if (state.page === "plan") renderPlan();
      else if (state.page === "period") renderPeriod();
      else if (state.page === "defaults") renderDefaults();
    } catch (err) {
      console.error(err);
    }
  }

  function renderCompPicker() {
    updateCompModalTitle();
    const bySector = listProvidersBySector();
    const order = ["은행", "증권", "생보", "손보", "기타"];
    const picker = $("#compPicker");
    if (!picker) return;

    let html = "";
    order.forEach((sec) => {
      const list = bySector[sec] || [];
      if (!list.length) return;
      html += `<div class="comp-sector-block"><span class="sec-label">${sec}</span><div class="comp-grid">`;
      list.forEach((n) => {
        const on = draftCompetitors.includes(n);
        const disabled = !on && draftCompetitors.length >= MAX_COMPETITORS ? "disabled" : "";
        html += `<label class="chk ${on ? "on" : ""}"><input type="checkbox" value="${n}" ${on ? "checked" : ""} ${disabled}/><span>${n}</span></label>`;
      });
      html += `</div></div>`;
    });
    picker.innerHTML = html || "<p class='note'>기준 분기 데이터가 없습니다.</p>";

    $$("#compPicker input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const on = [...document.querySelectorAll("#compPicker input:checked")].map((i) => i.value);
        if (on.length > MAX_COMPETITORS) {
          inp.checked = false;
          toast(`경쟁사는 최대 ${MAX_COMPETITORS}곳입니다.`);
          return;
        }
        draftCompetitors = on;
        updateCompModalTitle();
        $$("#compPicker label.chk").forEach((lab) => {
          const i = lab.querySelector("input");
          lab.classList.toggle("on", i && i.checked);
          if (i && !i.checked) i.disabled = draftCompetitors.length >= MAX_COMPETITORS;
          else if (i) i.disabled = false;
        });
      });
    });
  }

  function renderCompetitors() {
    updateCompTriggerLabel();
  }

  function applyFilterVisibility() {
    const p = state.page;
    const showRet = ["summary", "sector", "plan", "period"].includes(p);
    const showDo = p === "defaults";
    const showFee = p === "fees";
    const showQuarter = showRet || showDo;
    const showSector = ["summary", "sector", "plan", "period", "defaults"].includes(p);
    const showCompPick = showRet || showDo;
    $("#filterCommon").classList.toggle("hidden", p === "data");
    $$(".only-quarter").forEach((el) => el.classList.toggle("hidden", !showQuarter));
    $$(".only-common").forEach((el) => {
      if (el.classList.contains("competitor-field")) {
        el.classList.toggle("hidden", !showCompPick);
      } else if (el.classList.contains("only-fee-y")) {
        // 상품유형·기간은 수익률 계열 화면용 (수수료 산점도 제거)
        el.classList.toggle("hidden", !showRet);
      } else {
        el.classList.toggle("hidden", !showRet);
      }
    });
    $$(".only-sector").forEach((el) => el.classList.toggle("hidden", !showSector));
    $$(".only-defaults").forEach((el) => el.classList.toggle("hidden", !showDo));
    $$(".only-fees").forEach((el) => el.classList.toggle("hidden", !showFee));
  }

  function readFiltersFromUI() {
    const f = state.filters;
    f.baseQ = $("#fBaseQ").value || null;
    f.cmpQ = $("#fCmpQ").value || null;
    f.plan = $("#fPlan").value;
    f.type = $("#fType").value;
    f.period = $("#fPeriod").value;
    f.avgMode = $("#fAvg").value;
    f.minAum = Number($("#fMinAum").value) || 0;
    f.sector = $("#fSector").value;
    f.risk = $("#fRisk").value;
    f.doPeriod = $("#fDoPeriod").value;
    f.feeYear = $("#fFeeYear").value || null;
    f.feeCmpYear = $("#fFeeCmpYear").value || null;
    f.feeSector = $("#fFeeSector").value;
    f.feePlan = $("#fFeePlan").value;
  }

  /* ---------- charts helpers ---------- */
  function destroyChart(id) {
    if (state.charts[id]) {
      state.charts[id].destroy();
      delete state.charts[id];
    }
  }

  function makeChart(id, cfg) {
    destroyChart(id);
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    // 수익률 공시와 동일하게 기본 툴팁 소수점 2자리 (커스텀 callbacks.label이 있으면 유지)
    const opts = cfg.options || (cfg.options = {});
    const plugins = opts.plugins || (opts.plugins = {});
    const tooltip = plugins.tooltip || (plugins.tooltip = {});
    const callbacks = tooltip.callbacks || (tooltip.callbacks = {});
    if (!callbacks.label) {
      const decimals = cfg._decimals != null ? cfg._decimals : 2;
      const suffix = cfg._suffix != null ? cfg._suffix : "%";
      callbacks.label = function (ctx) {
        const ds = ctx.dataset.label ? ctx.dataset.label + ": " : "";
        let v = ctx.parsed && typeof ctx.parsed === "object" ? ctx.parsed.y : ctx.parsed;
        if (v == null || Number.isNaN(+v)) return ds + "—";
        return ds + fmt(+v, decimals) + suffix;
      };
    }
    state.charts[id] = new Chart(canvas, cfg);
    return state.charts[id];
  }

  function exportChartPng(id, filename) {
    const ch = state.charts[id];
    if (!ch) return toast("내보낼 차트가 없습니다.");
    const a = document.createElement("a");
    a.href = ch.toBase64Image("image/png", 1);
    a.download = filename || id + ".png";
    a.click();
  }

  /** rowspan/colspan을 펼쳐 AOA로 변환 (엑셀 저장용) */
  function tableToAoa(table) {
    const rows = [...table.querySelectorAll("tr")];
    const grid = [];
    const occupy = {}; // `${r},${c}` -> true

    rows.forEach((tr, r) => {
      if (!grid[r]) grid[r] = [];
      let c = 0;
      [...tr.children].forEach((cell) => {
        while (occupy[`${r},${c}`]) c++;
        const rs = Number(cell.rowSpan) || 1;
        const cs = Number(cell.colSpan) || 1;
        const raw =
          cell.getAttribute("data-xlsx") != null
            ? cell.getAttribute("data-xlsx")
            : (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
        for (let dr = 0; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (!grid[rr]) grid[rr] = [];
            grid[rr][cc] = dr === 0 && dc === 0 ? raw : grid[rr][cc] ?? raw;
            occupy[`${rr},${cc}`] = true;
          }
        }
        c += cs;
      });
    });
    const width = Math.max(0, ...grid.map((row) => row.length));
    return grid.map((row) => {
      const out = [];
      for (let i = 0; i < width; i++) out.push(row[i] != null ? row[i] : "");
      return out;
    });
  }

  function exportTableXlsx(tableId, filename) {
    const table = document.getElementById(tableId);
    if (!table) return toast("내보낼 표가 없습니다.");
    const aoa = tableToAoa(table);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 열 너비 대략 맞춤
    ws["!cols"] = aoa[0].map((_, i) => ({
      wch: Math.min(28, Math.max(8, ...aoa.map((r) => String(r[i] ?? "").length + 2))),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, filename || "export.xlsx");
    toast("엑셀을 저장했습니다.");
  }

  function deltaHtml(cur, prev) {
    const d = Calc.deltaRank(cur, prev);
    const f = Calc.formatDelta(d);
    return `<span class="${f.cls}">${f.text}</span>`;
  }

  /* ---------- pages ---------- */
  function renderSummary() {
    const f = state.filters;
    if (!applyPeriodAvailability()) return;
    const baseQ = f.baseQ;
    const cmpQ = f.cmpQ && hasPeriodData("returns", f.cmpQ) ? f.cmpQ : null;
    const indexed = Calc.indexReturns(state.data.returns[baseQ] || []);
    const ranked = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: f.sector,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const me = Calc.findRank(ranked, COMPANY);
    const prevIndexed = cmpQ ? Calc.indexReturns(state.data.returns[cmpQ] || []) : null;
    const prevRanked = prevIndexed
      ? Calc.rankList(prevIndexed, {
          plan: f.plan,
          type: f.type,
          period: f.period,
          sector: f.sector,
          minAum: f.minAum,
          avgMode: f.avgMode,
        })
      : null;
    const mePrev = prevRanked ? Calc.findRank(prevRanked, COMPANY) : null;

    const secLabel = f.sector === "전체" ? "증권" : f.sector;
    const secForRank = f.sector === "전체" ? "증권" : f.sector;

    // 1) 총적립금: 전체 사업자 · 전 제도
    const totalAllPlans = sumAllPlansAum(indexed, "전체");
    const prevTotalAll = prevIndexed ? sumAllPlansAum(prevIndexed, "전체") : null;
    const totalChg =
      prevTotalAll && prevTotalAll > 0 ? ((totalAllPlans - prevTotalAll) / prevTotalAll) * 100 : null;
    const providerN = new Set([...indexed.keys()]).size;
    $("#kpiTotal").textContent = fmtAum(totalAllPlans);
    $("#kpiTotal").className = "value";
    $("#kpiTotalMeta").innerHTML =
      kpiLine("비교 시점 대비", fmtPctChg(totalChg), valCls(totalChg)) +
      kpiLine("사업자 수", providerN ? `${providerN}곳` : "—");

    // 2) 당사 적립금 (선택 제도)
    const myAum = Calc.totalAum(indexed.get(COMPANY), f.plan) || 0;
    const prevMyAum = prevIndexed ? Calc.totalAum(prevIndexed.get(COMPANY), f.plan) || 0 : null;
    const myAumChg =
      prevMyAum != null && prevMyAum > 0 ? ((myAum - prevMyAum) / prevMyAum) * 100 : null;
    const secAum = sumPlanAum(indexed, f.plan, secForRank);
    const allAum = sumPlanAum(indexed, f.plan, "전체");
    const shareSec = secAum > 0 ? (myAum / secAum) * 100 : null;
    const shareAll = allAum > 0 ? (myAum / allAum) * 100 : null;
    const aumRk = aumRankOf(indexed, f.plan, secForRank, COMPANY);
    $("#kpiMyAum").textContent = fmtAum(myAum);
    $("#kpiMyAum").className = "value";
    $("#kpiMyAumMeta").innerHTML =
      kpiLine(
        `${secLabel} 업권 내 순위`,
        aumRk.rank != null ? fmtRank(aumRk.rank, aumRk.n) : "—"
      ) +
      kpiLine(`${secLabel} 업권 점유율`, shareSec != null ? fmtPct(shareSec) : "—") +
      kpiLine("전체 시장 점유율", shareAll != null ? fmtPct(shareAll) : "—") +
      kpiLine("비교 시점 대비", fmtPctChg(myAumChg), valCls(myAumChg));

    // 3) 당사 수익률
    const rankedSec = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: secForRank,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const meSec = Calc.findRank(rankedSec, COMPANY);
    const prevRankedSec = prevIndexed
      ? Calc.rankList(prevIndexed, {
          plan: f.plan,
          type: f.type,
          period: f.period,
          sector: secForRank,
          minAum: f.minAum,
          avgMode: f.avgMode,
        })
      : null;
    const meSecPrev = prevRankedSec ? Calc.findRank(prevRankedSec, COMPANY) : null;
    const rankedAll = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: "전체",
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const meAll = Calc.findRank(rankedAll, COMPANY);
    const typeShort = f.type === "원리금보장(통합)" ? "원리금보장" : f.type;
    $("#kpiRetLabel").textContent = `· ${f.plan} ${typeShort} ${f.period}년`;
    $("#kpiRet").textContent = meSec ? fmtPct(meSec.ret) : me ? fmtPct(me.ret) : "—";
    $("#kpiRet").className = "value";
    $("#kpiRetMeta").innerHTML =
      kpiLine(
        `${secLabel} 업권 내 순위`,
        meSec
          ? `${fmtRank(meSec.rank, rankedSec.n)} ${deltaHtml(meSec.rank, meSecPrev && meSecPrev.rank)}`
          : "—"
      ) +
      kpiLine(
        "전체 순위(보조)",
        meAll ? fmtRank(meAll.rank, rankedAll.n) : "—"
      );

    // 4) 평균 대비
    const gapSec =
      meSec && rankedSec.avg != null ? meSec.ret - rankedSec.avg : null;
    const gapAll = meAll && rankedAll.avg != null ? meAll.ret - rankedAll.avg : null;
    const top = rankedSec.list[0] || null;
    const gapTop = meSec && top && top.ret != null ? meSec.ret - top.ret : null;
    const gapEl = $("#kpiGap");
    gapEl.textContent = gapSec != null ? fmtPp(gapSec) : "—";
    gapEl.className = "value " + valCls(gapSec);
    $("#kpiGapMeta").innerHTML =
      kpiLine(`${secLabel} 업권 평균`, rankedSec.avg != null ? fmtPct(rankedSec.avg) : "—") +
      kpiLine("전체 평균", rankedAll.avg != null ? fmtPct(rankedAll.avg) : "—") +
      (gapAll != null ? kpiLine("전체 평균 대비", fmtPp(gapAll), valCls(gapAll)) : "") +
      kpiLine(
        top ? `1위 대비 (${top.name})` : "1위 대비",
        gapTop != null ? fmtPp(gapTop) : "—",
        valCls(gapTop)
      );

    // 5) 수수료
    const feeYear = feesYearFor(f.feeYear) || f.feeYear;
    const feeRows = state.data.fees[feeYear] || [];
    const feeList = Calc.rankFees(feeRows, f.plan, secForRank);
    const feeMeRow = feeList.find((r) => r.name === COMPANY);
    const feeVal = feeMeRow ? feeMeRow.rate : null;
    const feeAvg = feeList.length
      ? feeList.reduce((a, b) => a + b.rate, 0) / feeList.length
      : null;
    $("#kpiFeeLabel").textContent = feeYear ? `· ${f.plan} ${feeYear}년` : `· ${f.plan}`;
    $("#kpiFee").textContent = feeVal != null ? fmt(feeVal, 2) + "%" : "—";
    $("#kpiFee").className = "value";
    $("#kpiFeeMeta").innerHTML =
      kpiLine(
        "업권 내 순위(낮을수록 1위)",
        feeMeRow ? fmtRank(feeMeRow.rank, feeList.length) : "—"
      ) +
      kpiLine(`${secLabel} 업권 평균`, feeAvg != null ? fmt(feeAvg, 2) + "%" : "—");

    // rank matrix 제도×유형×기간 (1·3·5·7·10년, 제도 병합)
    const plans = ["DB", "DC", "IRP"];
    const types = ["예금성", "시장성", "실적배당형", "원리금보장(통합)"];
    const periods = ["1", "3", "5", "7", "10"];
    let html = `<table class="data rank-matrix" id="tblRankMatrix"><thead><tr>
      <th class="left col-plan">제도</th><th class="left col-type">유형</th>`;
    periods.forEach((p) => {
      html += `<th class="col-period">${p}년${p === "1" ? "" : '<div class="th-sub">연환산</div>'}</th>`;
    });
    html += `</tr></thead><tbody>`;
    for (const pl of plans) {
      types.forEach((ty, ti) => {
        const rowCls = ti === 0 ? "plan-block-start" : "";
        html += `<tr class="${rowCls}">`;
        if (ti === 0) {
          html += `<td class="left plan-cell" rowspan="${types.length}" data-xlsx="${pl}">${pl}</td>`;
        }
        html += `<td class="left type-cell" data-xlsx="${ty}">${ty}</td>`;
        for (const pe of periods) {
          const opts = {
            plan: pl,
            type: ty,
            period: pe,
            sector: f.sector,
            minAum: f.minAum,
            avgMode: f.avgMode,
          };
          const rk = Calc.rankList(indexed, opts);
          const m = Calc.findRank(rk, COMPANY);
          const prevRk = prevIndexed ? Calc.rankList(prevIndexed, opts) : null;
          const mp = prevRk ? Calc.findRank(prevRk, COMPANY) : null;
          const dHtml = deltaHtml(m && m.rank, mp && mp.rank);
          const xlsx = m ? `${fmtRank(m.rank, rk.n)} / ${fmt(m.ret)}%` : "—";
          const cell = m
            ? `<span class="rank-main">${fmtRank(m.rank, rk.n)} ${dHtml}</span><span class="rank-sub">${fmt(m.ret)}%</span>`
            : `<span class="rank-empty">—</span>`;
          html += `<td class="clickable rank-cell" data-xlsx="${xlsx}" data-plan="${pl}" data-type="${ty}" data-period="${pe}">${cell}</td>`;
        }
        html += `</tr>`;
      });
    }
    html += `</tbody></table>`;
    $("#rankMatrix").innerHTML = html;
    $$("#rankMatrix td.clickable").forEach((td) => {
      td.addEventListener("click", () => {
        state.filters.plan = td.dataset.plan;
        state.filters.type = td.dataset.type;
        state.filters.period = td.dataset.period;
        syncFilterControls();
        renderPage();
        toast(`필터: ${td.dataset.plan} · ${td.dataset.type} · ${td.dataset.period}년`);
      });
    });

    // TOP5 chart — 축은 짧은 라벨, 툴팁은 정식 사명
    const top5 = ranked.list.slice(0, 5);
    const shortLabel = (name) =>
      name.replace(/투자증권$/, "").replace(/증권$/, "").replace(/생명보험$/, "생명").replace(/손해보험$/, "손보");
    // 1~5위: 남청→청록 그라데이션, 당사는 한화 오렌지
    const TOP5_PALETTE = ["#0f2744", "#1a4558", "#2a6878", "#3d8a8f", "#5eada5"];
    const TOP5_BORDER = ["#0a1a2e", "#123440", "#1e4f5c", "#2d6b6f", "#458a83"];
    const barColors = top5.map((r, i) =>
      r.name === COMPANY ? "#e85d04" : TOP5_PALETTE[i] || TOP5_PALETTE[4]
    );
    const barBorders = top5.map((r, i) =>
      r.name === COMPANY ? "#c44d00" : TOP5_BORDER[i] || TOP5_BORDER[4]
    );
    makeChart("chartTop5", {
      type: "bar",
      data: {
        labels: top5.map((r) => shortLabel(r.name)),
        datasets: [
          {
            label: "수익률(%)",
            data: top5.map((r) => r.ret),
            backgroundColor: barColors,
            borderColor: barBorders,
            borderWidth: 1.5,
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22, bottom: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15,39,68,0.92)",
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              title(items) {
                const i = items[0].dataIndex;
                const row = top5[i];
                return row ? `${row.rank}위 · ${row.name}` : items[0].label;
              },
              label(ctx) {
                return `수익률 ${fmt(ctx.parsed.y)}%`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: "#5c6b7a", font: { size: 11, weight: "600" } },
          },
          y: {
            grid: { color: "rgba(15,39,68,0.08)" },
            ticks: {
              color: "#5c6b7a",
              callback(v) {
                return v + "%";
              },
            },
            title: {
              display: true,
              text: "수익률 (%)",
              color: "#5c6b7a",
              font: { size: 11 },
            },
          },
        },
      },
      plugins: [
        {
          id: "top5ValueLabels",
          afterDatasetsDraw(chart) {
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            meta.data.forEach((bar, i) => {
              const v = chart.data.datasets[0].data[i];
              if (v == null || Number.isNaN(v)) return;
              const isMe = top5[i] && top5[i].name === COMPANY;
              ctx.save();
              ctx.font = '600 11px "Malgun Gothic", "Noto Sans KR", sans-serif';
              ctx.fillStyle = isMe ? "#c44d00" : "#0f2744";
              ctx.textAlign = "center";
              ctx.textBaseline = "bottom";
              ctx.fillText(fmt(v) + "%", bar.x, bar.y - 4);
              ctx.restore();
            });
          },
        },
      ],
    });

    // 당사 유형별 수익률 추이 8Q
    const qs = Calc.sortQuarters(Object.keys(state.data.returns)).slice(-8);
    const typeLines = [
      { key: "예금성", color: "#1565c0" },
      { key: "시장성", color: "#6a1b9a" },
      { key: "실적배당형", color: "#2e7d32" },
      { key: "원리금보장(통합)", color: "#e85d04" },
    ];
    makeChart("chartTrend", {
      type: "line",
      data: {
        labels: qs,
        datasets: typeLines.map((t) => ({
          label: t.key,
          data: qs.map((q) => {
            const idx = Calc.indexReturns(state.data.returns[q] || []);
            return Calc.metricFor(idx.get(COMPANY), f.plan, t.key, f.period).ret;
          }),
          borderColor: t.color,
          backgroundColor: t.color,
          tension: 0.25,
          spanGaps: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { title: { display: true, text: "수익률 (%)" } } },
      },
    });

    // 경쟁사 비교: 업권 순위 + 비중 + 순위변동 + 평균 대비 %p
    const names = [COMPANY, ...f.competitors];
    const typeCols = ["예금성", "시장성", "실적배당형"];
    const feeYearEff = feesYearFor(f.feeYear) || f.feeYear;
    const feeRowsAll = state.data.fees[feeYearEff] || [];

    const aumPool = [];
    let sectorAumSum = 0;
    for (const e of indexed.values()) {
      if (f.sector !== "전체" && e.sector !== f.sector) continue;
      const a = Calc.totalAum(e, f.plan);
      if (a == null) continue;
      aumPool.push({ name: e.name, aum: a });
      sectorAumSum += a;
    }
    aumPool.sort((a, b) => b.aum - a.aum);
    const aumRankMap = new Map();
    let ar = 0;
    let aLast = null;
    aumPool.forEach((row, i) => {
      if (aLast === null || row.aum !== aLast) ar = i + 1;
      aumRankMap.set(row.name, { rank: ar, n: aumPool.length });
      aLast = row.aum;
    });

    const typeRankMap = {};
    const typeRankPrev = {};
    for (const ty of typeCols) {
      const opts = {
        plan: f.plan,
        type: ty,
        period: f.period,
        sector: f.sector,
        minAum: f.minAum,
        avgMode: f.avgMode,
      };
      typeRankMap[ty] = Calc.rankList(indexed, opts);
      typeRankPrev[ty] = prevIndexed ? Calc.rankList(prevIndexed, opts) : null;
    }
    const feeRanked = Calc.rankFees(feeRowsAll, f.plan, f.sector);

    const gapHtml = (diff) => {
      if (diff == null || Number.isNaN(diff)) return `<span class="comp-gap">—</span>`;
      const cls = diff > 0 ? "gap-plus" : diff < 0 ? "gap-minus" : "gap-zero";
      return `<span class="comp-gap ${cls}">${fmtPp(diff)}</span>`;
    };

    let chtml = `<table class="data comp-table" id="tblComp"><thead><tr>
      <th class="left">사업자</th>
      <th>적립금<br><span class="th-sub">업권순위 · 비중</span></th>
      ${typeCols
        .map(
          (t) =>
            `<th>${t}<br><span class="th-sub">업권순위 · 평균대비</span></th>`
        )
        .join("")}
      <th>수수료(${feeYearEff || "—"})<br><span class="th-sub">업권순위</span></th>
    </tr></thead><tbody>`;

    for (const n of names) {
      const entry = indexed.get(n);
      const tot = Calc.totalAum(entry, f.plan);
      const feeRow = feeRowsAll.find((r) => r.name === n);
      const fee = feeRow ? Calc.feeRate(feeRow, f.plan) : null;
      const feeHit = feeRanked.find((r) => r.name === n);
      const cls = n === COMPANY ? "me" : "comp";
      const aumR = aumRankMap.get(n);
      const sectorShare = tot != null && sectorAumSum ? (tot / sectorAumSum) * 100 : null;
      const eqShare = Calc.equityShare(entry, f.plan);

      chtml += `<tr class="${cls}"><td class="left">${n}</td>`;

      // 적립금: 금액 + 업권순위 + 업권비중·실적배당비중
      const aumRankTxt = aumR ? `업권 ${fmtRank(aumR.rank, aumR.n)}` : "업권 —";
      const shareTxt = `업권비중 ${sectorShare == null ? "—" : fmt(sectorShare) + "%"} · 실적배당 ${eqShare == null ? "—" : fmt(eqShare) + "%"}`;
      chtml += `<td data-xlsx="${tot == null ? "—" : `${fmtAum(tot)} / ${aumRankTxt} / ${shareTxt}`}">
        <div class="comp-cell">
          <div class="comp-val">${fmtAum(tot)}</div>
          <div class="comp-rank">${aumRankTxt}</div>
          <div class="comp-meta">${shareTxt}</div>
        </div></td>`;

      for (const ty of typeCols) {
        const m = Calc.metricFor(entry, f.plan, ty, f.period);
        const hit = Calc.findRank(typeRankMap[ty], n);
        const prevHit = typeRankPrev[ty] ? Calc.findRank(typeRankPrev[ty], n) : null;
        const rankTxt = hit ? `업권 ${fmtRank(hit.rank, typeRankMap[ty].n)}` : "업권 —";
        const dHtml = deltaHtml(hit && hit.rank, prevHit && prevHit.rank);
        const avg = typeRankMap[ty].avg;
        const gap = m.ret != null && avg != null ? m.ret - avg : null;
        chtml += `<td data-xlsx="${
          m.ret == null
            ? "—"
            : `${fmt(m.ret)}% / ${rankTxt} / ${fmtPp(gap)}`
        }">
          <div class="comp-cell">
            <div class="comp-val">${m.ret == null ? "—" : fmt(m.ret) + "%"}</div>
            <div class="comp-rank">${rankTxt} ${dHtml}</div>
            <div class="comp-meta">${gapHtml(gap)}</div>
          </div></td>`;
      }

      const feeRankTxt = feeHit ? `업권 ${fmtRank(feeHit.rank, feeRanked.length)}` : "업권 —";
      chtml += `<td data-xlsx="${fee == null ? "—" : `${fmt(fee, 3)}% / ${feeRankTxt}`}">
        <div class="comp-cell">
          <div class="comp-val">${fee == null ? "—" : fmt(fee, 3) + "%"}</div>
          <div class="comp-rank">${feeRankTxt}</div>
        </div></td>`;
      chtml += `</tr>`;
    }
    chtml += `</tbody></table>`;
    $("#compTable").innerHTML = chtml;
    const noteEl = $("#compNote");
    if (noteEl) {
      noteEl.textContent = `${f.sector} 업권 순위 · ${f.plan} · ${f.period}년 · 비교 ${cmpPeriodNote("returns", f.cmpQ)} 대비 ▲▼ · 평균대비 %p · 수수료 낮을수록 상위(${feeYearEff || "—"}년)`;
    }
  }

  function renderSector() {
    const f = state.filters;
    if (!applyPeriodAvailability()) return;
    const sectors = ["은행", "증권", "생보", "손보"];
    const baseQ = f.baseQ;
    const cmpQ = f.cmpQ && hasPeriodData("returns", f.cmpQ) ? f.cmpQ : null;
    const indexed = Calc.indexReturns(state.data.returns[baseQ] || []);
    const avgs = sectors.map((s) => {
      const rk = Calc.rankList(indexed, {
        plan: f.plan,
        type: f.type,
        period: f.period,
        sector: s,
        minAum: f.minAum,
        avgMode: f.avgMode,
      });
      return { s, avg: rk.avg, n: rk.n };
    });
    const all = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: "전체",
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    makeChart("chartSectorAvg", {
      type: "bar",
      data: {
        labels: avgs.map((a) => a.s),
        datasets: [
          {
            label: "업권 평균",
            data: avgs.map((a) => a.avg),
            backgroundColor: "#4a6fa5",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          annotation: undefined,
          legend: { display: false },
        },
        scales: {
          y: {
            title: { display: true, text: "%" },
          },
        },
      },
      plugins: [
        {
          id: "avgLine",
          afterDraw(chart) {
            if (all.avg == null) return;
            const {
              ctx,
              chartArea: { left, right },
              scales: { y },
            } = chart;
            const yy = y.getPixelForValue(all.avg);
            ctx.save();
            ctx.strokeStyle = "#e85d04";
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(left, yy);
            ctx.lineTo(right, yy);
            ctx.stroke();
            ctx.fillStyle = "#e85d04";
            ctx.font = "12px sans-serif";
            ctx.fillText(`전체 ${fmt(all.avg)}%`, right - 78, yy - 6);
            ctx.restore();
          },
        },
      ],
    });

    // sector trend
    const qs = Calc.sortQuarters(Object.keys(state.data.returns)).slice(-8);
    const colors = { 은행: "#2e7d32", 증권: "#e85d04", 생보: "#1565c0", 손보: "#6a1b9a" };
    makeChart("chartSectorTrend", {
      type: "line",
      data: {
        labels: qs,
        datasets: sectors.map((s) => ({
          label: s,
          data: qs.map((q) => {
            const idx = Calc.indexReturns(state.data.returns[q] || []);
            return Calc.rankList(idx, {
              plan: f.plan,
              type: f.type,
              period: f.period,
              sector: s,
              minAum: f.minAum,
              avgMode: f.avgMode,
            }).avg;
          }),
          borderColor: colors[s],
          tension: 0.25,
          spanGaps: true,
        })),
      },
      options: { responsive: true, maintainAspectRatio: false },
    });

    const ranked = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: f.sector,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const prevIndexed = cmpQ ? Calc.indexReturns(state.data.returns[cmpQ] || []) : null;
    const prevRanked = prevIndexed
      ? Calc.rankList(prevIndexed, {
          plan: f.plan,
          type: f.type,
          period: f.period,
          sector: f.sector,
          minAum: f.minAum,
          avgMode: f.avgMode,
        })
      : null;

    let sumAum = ranked.list.reduce((s, r) => s + (r.aum || 0), 0);
    let html = `<table class="data" id="tblSectorRank"><thead><tr><th>순위</th><th class="left">사업자</th><th>수익률</th><th>적립금</th><th>점유율</th><th>증감</th><th>변동</th></tr></thead><tbody>`;
    for (const r of ranked.list) {
      const prev = prevRanked ? Calc.findRank(prevRanked, r.name) : null;
      const share = sumAum ? ((r.aum || 0) / sumAum) * 100 : null;
      const dAum = prev && r.aum != null && prev.aum != null ? r.aum - prev.aum : null;
      const cls = r.name === COMPANY ? "me" : state.filters.competitors.includes(r.name) ? "comp" : "";
      html += `<tr class="${cls}"><td>${r.rank}</td><td class="left">${r.name}</td><td>${fmt(r.ret)}</td><td>${fmtAum(r.aum)}</td><td>${fmt(share)}</td><td>${dAum == null ? "—" : fmtAum(dAum)}</td><td>${deltaHtml(r.rank, prev && prev.rank)}</td></tr>`;
    }
    html += `</tbody></table>`;
    $("#sectorRank").innerHTML = html;
  }

  function renderPlan() {
    const f = state.filters;
    if (!applyPeriodAvailability()) return;
    const baseQ = f.baseQ;
    const indexed = Calc.indexReturns(state.data.returns[baseQ] || []);
    const plans = ["DB", "DC", "IRP"];
    const me = [];
    const sec = [];
    const all = [];
    for (const pl of plans) {
      const rkSec = Calc.rankList(indexed, {
        plan: pl,
        type: f.type,
        period: f.period,
        sector: f.sector,
        minAum: f.minAum,
        avgMode: f.avgMode,
      });
      const rkAll = Calc.rankList(indexed, {
        plan: pl,
        type: f.type,
        period: f.period,
        sector: "전체",
        minAum: f.minAum,
        avgMode: f.avgMode,
      });
      const m = Calc.findRank(rkSec, COMPANY);
      me.push(m ? m.ret : null);
      sec.push(rkSec.avg);
      all.push(rkAll.avg);
    }
    makeChart("chartPlanCmp", {
      type: "bar",
      data: {
        labels: plans,
        datasets: [
          { label: "당사", data: me, backgroundColor: "#e85d04" },
          { label: `${f.sector} 평균`, data: sec, backgroundColor: "#4a6fa5" },
          { label: "전체 평균", data: all, backgroundColor: "#90a4ae" },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });

    // 제도별 적립금 구성 — 당사·업권·전체 가로 100% 누적 막대
    function aumRow(filterFn) {
      const out = { DB: 0, DC: 0, IRP: 0 };
      for (const e of indexed.values()) {
        if (!filterFn(e)) continue;
        for (const pl of plans) out[pl] += Calc.totalAum(e, pl) || 0;
      }
      return out;
    }
    const mixLabels = ["당사", "은행", "증권", "생보", "손보", "전체"];
    const mixRows = [
      aumRow((e) => e.name === COMPANY),
      aumRow((e) => e.sector === "은행"),
      aumRow((e) => e.sector === "증권"),
      aumRow((e) => e.sector === "생보"),
      aumRow((e) => e.sector === "손보"),
      aumRow(() => true),
    ];
    const mixPct = (row, pl) => {
      const tot = row.DB + row.DC + row.IRP;
      return tot > 0 ? (row[pl] / tot) * 100 : 0;
    };
    const mixColors = { DB: "#3d4f66", DC: "#7a8fa3", IRP: "#c5ced6" };
    makeChart("chartPlanAum", {
      type: "bar",
      data: {
        labels: mixLabels,
        datasets: plans.map((pl) => ({
          label: pl,
          data: mixRows.map((r) => mixPct(r, pl)),
          backgroundColor: mixColors[pl],
          stack: "mix",
          aumRaw: mixRows.map((r) => r[pl]),
        })),
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label(ctx) {
                const pl = ctx.dataset.label;
                const pct = ctx.parsed.x;
                const aum = ctx.dataset.aumRaw[ctx.dataIndex];
                if (pct == null || Number.isNaN(pct)) return `${pl}: —`;
                return `${pl}: ${fmt(pct)}% (${aum ? fmtAum(aum) : "—"})`;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            min: 0,
            max: 100,
            ticks: {
              stepSize: 10,
              callback(v) {
                return v + "%";
              },
            },
          },
          y: { stacked: true },
        },
      },
    });

    // equity share trend: 당사 · 증권업 · 전체 · 경쟁사
    const qs = Calc.sortQuarters(Object.keys(state.data.returns)).slice(-8);
    const equitySeries = [
      {
        label: "당사",
        color: "#e85d04",
        width: 2.5,
        dash: [],
        get: (idx) => Calc.equityShare(idx.get(COMPANY), f.plan),
      },
      {
        label: "증권업",
        color: "#1565c0",
        width: 2,
        dash: [6, 4],
        get: (idx) => Calc.equityShareAggregate(idx, f.plan, "증권"),
      },
      {
        label: "전체",
        color: "#546e7a",
        width: 2,
        dash: [2, 3],
        get: (idx) => Calc.equityShareAggregate(idx, f.plan, "전체"),
      },
      ...f.competitors.map((n, i) => {
        const colors = ["#2e7d32", "#6a1b9a", "#00838f", "#ef6c00", "#ad1457", "#455a64"];
        return {
          label: n,
          color: colors[i % colors.length],
          width: 1.5,
          dash: [],
          get: (idx) => Calc.equityShare(idx.get(n), f.plan),
        };
      }),
    ];
    makeChart("chartEquity", {
      type: "line",
      data: {
        labels: qs,
        datasets: equitySeries.map((s) => ({
          label: s.label,
          data: qs.map((q) => {
            const idx = Calc.indexReturns(state.data.returns[q] || []);
            return s.get(idx);
          }),
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: s.width,
          borderDash: s.dash,
          tension: 0.25,
          spanGaps: true,
          pointRadius: 2,
          pointHoverRadius: 4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { title: { display: true, text: "실적배당 비중 %" } } },
      },
    });

    // provider × plan table
    const providers = [...indexed.values()]
      .filter((e) => f.sector === "전체" || e.sector === f.sector)
      .map((e) => {
        const tot = plans.reduce((s, pl) => s + (Calc.totalAum(e, pl) || 0), 0);
        return { e, tot };
      })
      .sort((a, b) => b.tot - a.tot);

    let html = `<table class="data" id="tblPlanProv"><thead>
      <tr>
        <th class="left" rowspan="2">사업자</th>
        <th rowspan="2">합계</th>
        ${plans.map((pl) => `<th colspan="2">${pl}</th>`).join("")}
      </tr>
      <tr>
        ${plans.map(() => `<th>적립금</th><th>수익률</th>`).join("")}
      </tr>
    </thead><tbody>`;
    for (const { e, tot } of providers) {
      const cls = e.name === COMPANY ? "me" : f.competitors.includes(e.name) ? "comp" : "";
      html += `<tr class="${cls}"><td class="left">${e.name}</td><td>${fmtAum(tot)}</td>`;
      for (const pl of plans) {
        const m = Calc.metricFor(e, pl, f.type, f.period);
        html += `<td>${fmtAum(Calc.totalAum(e, pl))}</td><td>${fmt(m.ret)}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    $("#planProv").innerHTML = html;
  }

  function renderPeriod() {
    const f = state.filters;
    if (!applyPeriodAvailability()) return;
    const baseQ = f.baseQ;
    const indexed = Calc.indexReturns(state.data.returns[baseQ] || []);
    const periods = ["1", "3", "5", "7", "10"];
    const periodRankOpts = (period, sector) => ({
      plan: f.plan,
      type: f.type,
      period,
      sector,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const periodSeries = [
      {
        label: "당사",
        color: "#e85d04",
        width: 2.5,
        dash: [],
        point: 4,
        get: (p) => Calc.metricFor(indexed.get(COMPANY), f.plan, f.type, p).ret,
      },
      {
        label: "증권 업권 평균",
        color: "#7c3aed",
        width: 2,
        dash: [6, 4],
        point: 0,
        get: (p) => Calc.rankList(indexed, periodRankOpts(p, "증권")).avg,
      },
      {
        label: "전체 평균",
        color: "#94a3b8",
        width: 2,
        dash: [2, 3],
        point: 0,
        get: (p) => Calc.rankList(indexed, periodRankOpts(p, "전체")).avg,
      },
      ...f.competitors.map((n, i) => {
        const colors = ["#1565c0", "#00838f", "#2e7d32", "#ef6c00", "#ad1457", "#455a64"];
        return {
          label: n,
          color: colors[i % colors.length],
          width: 1.5,
          dash: [],
          point: 2,
          get: (p) => Calc.metricFor(indexed.get(n), f.plan, f.type, p).ret,
        };
      }),
    ];
    makeChart("chartPeriod", {
      type: "line",
      data: {
        labels: periods.map((p) => p + "년"),
        datasets: periodSeries.map((s) => ({
          label: s.label,
          data: periods.map((p) => s.get(p)),
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: s.width,
          borderDash: s.dash,
          tension: 0.25,
          spanGaps: true,
          pointRadius: s.point,
          pointHoverRadius: 5,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            title: { display: true, text: "수익률 %" },
            ticks: {
              callback(v) {
                return v + "%";
              },
            },
          },
        },
      },
    });
    const periodCurveNote = $("#periodCurveNote");
    if (periodCurveNote) {
      periodCurveNote.textContent = `${f.plan} · ${f.type} · 3년 이상 연환산 · 당사·증권업·전체 + 선택 경쟁사. 범례 클릭으로 선 on/off`;
    }

    const cmpQ = f.cmpQ && hasPeriodData("returns", f.cmpQ) ? f.cmpQ : null;
    const prevIndexed = cmpQ ? Calc.indexReturns(state.data.returns[cmpQ] || []) : null;
    const sectorRankLabel = f.sector === "전체" ? "전체 순위" : `${f.sector} 순위`;
    const cmpLabel = cmpPeriodNote("returns", f.cmpQ);
    const periodMeNote = $("#periodMeNote");
    if (periodMeNote) {
      periodMeNote.textContent = `${f.plan} · ${f.type} · ${
        f.sector === "전체" ? "전체" : f.sector + " 업권 내"
      } · 변동은 ${cmpLabel} 대비`;
    }

    function gapHtml(v) {
      if (v == null || Number.isNaN(v)) return "—";
      const cls = v > 0.005 ? "gap-plus" : v < -0.005 ? "gap-minus" : "gap-zero";
      const sign = v > 0 ? "+" : "";
      return `<span class="do-gap ${cls}">${sign}${fmt(v)}%p</span>`;
    }

    let html = `<table class="data period-me-table" id="tblPeriodMe"><thead><tr>
      <th>기간</th>
      <th>당사 수익률</th>
      <th>${sectorRankLabel}</th>
      <th>변동</th>
      <th>업권 평균</th>
      <th>업권 평균 대비</th>
      <th>전체 평균 대비</th>
      <th class="left">1위</th>
      <th>1위 대비</th>
    </tr></thead><tbody>`;

    for (const p of periods) {
      const rankOpts = {
        plan: f.plan,
        type: f.type,
        period: p,
        sector: f.sector,
        minAum: f.minAum,
        avgMode: f.avgMode,
      };
      const rk = Calc.rankList(indexed, rankOpts);
      const rkAll = Calc.rankList(indexed, { ...rankOpts, sector: "전체" });
      const m = Calc.findRank(rk, COMPANY);
      const prevRk = prevIndexed ? Calc.rankList(prevIndexed, rankOpts) : null;
      const mp = prevRk ? Calc.findRank(prevRk, COMPANY) : null;
      const top = rk.list[0] || null;
      const sectorAvg = rk.avg;
      const allAvg = rkAll.avg;
      const myRet = m ? m.ret : null;
      const gapSec = myRet != null && sectorAvg != null ? myRet - sectorAvg : null;
      const gapAll = myRet != null && allAvg != null ? myRet - allAvg : null;
      const gapTop = myRet != null && top && top.ret != null ? myRet - top.ret : null;
      const rankTxt = m ? fmtRank(m.rank, rk.n) : "—";
      const topTxt = top ? `${top.name} ${fmt(top.ret)}` : "—";
      const periodLabel = p === "1" ? "1년" : `${p}년`;

      html += `<tr class="me">
        <td>${periodLabel}</td>
        <td>${fmt(myRet)}</td>
        <td>${rankTxt}</td>
        <td>${deltaHtml(m && m.rank, mp && mp.rank)}</td>
        <td>${fmt(sectorAvg)}</td>
        <td>${gapHtml(gapSec)}</td>
        <td>${gapHtml(gapAll)}</td>
        <td class="left">${topTxt}</td>
        <td>${gapHtml(gapTop)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    $("#periodMe").innerHTML = html;

    const rk1 = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: "1",
      sector: f.sector,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    let h2 = `<table class="data" id="tblPeriodProv"><thead><tr><th>순위</th><th class="left">사업자</th>`;
    periods.forEach((p) => (h2 += `<th>${p}년</th>`));
    h2 += `</tr></thead><tbody>`;
    for (const r of rk1.list) {
      const e = indexed.get(r.name);
      const cls = r.name === COMPANY ? "me" : f.competitors.includes(r.name) ? "comp" : "";
      h2 += `<tr class="${cls}"><td>${r.rank}</td><td class="left">${r.name}</td>`;
      for (const p of periods) {
        h2 += `<td>${fmt(Calc.metricFor(e, f.plan, f.type, p).ret)}</td>`;
      }
      h2 += `</tr>`;
    }
    h2 += `</tbody></table>`;
    $("#periodProv").innerHTML = h2;
  }

  function renderDefaults() {
    const f = state.filters;
    if (!applyPeriodAvailability()) return;
    const doQ = f.baseQ;
    const doCmpQ = f.cmpQ && hasPeriodData("defaults", f.cmpQ) ? f.cmpQ : null;
    const rows = state.data.defaults[doQ] || [];
    const list = Calc.aggregateDefaults(rows, f.risk, f.doPeriod).filter(
      (r) => f.sector === "전체" || r.sector === f.sector
    );
    // 업권 필터 후 동률 순위 재부여 (1,1,3)
    Calc.assignCompetitionRanks(list, (r) => r.ret);

    const risks = ["초저위험", "저위험", "중위험", "고위험"];
    const doPeriodLabel =
      ({ "1m": "1개월", "3m": "3개월", "6m": "6개월", "1y": "1년", "3y": "3년" }[f.doPeriod] ||
        f.doPeriod);
    const doQLabel = formatPeriodLabel(doQ);

    function weightedDoAvg(filterFn, risk) {
      const sub = Calc.aggregateDefaults(rows, risk, f.doPeriod).filter(filterFn);
      if (!sub.length) return null;
      const den = sub.reduce((a, b) => a + (b.aum || 0), 0);
      if (!den) return sub.reduce((a, b) => a + b.ret, 0) / sub.length;
      return sub.reduce((a, b) => a + b.ret * (b.aum || 0), 0) / den;
    }

    const avgSeries = [
      { label: "은행 평균", color: "#3b82f6", filter: (r) => r.sector === "은행" },
      { label: "증권 평균", color: "#7c3aed", filter: (r) => r.sector === "증권" },
      { label: "생보 평균", color: "#16a34a", filter: (r) => r.sector === "생보" },
      { label: "손보 평균", color: "#ca8a04", filter: (r) => r.sector === "손보" },
      { label: "당사", color: "#e85d04", filter: (r) => r.name === COMPANY },
      { label: "전체 평균", color: "#94a3b8", filter: () => true },
    ];
    makeChart("chartDoAvg", {
      type: "bar",
      data: {
        labels: risks,
        datasets: avgSeries.map((s) => ({
          label: s.label,
          data: risks.map((rk) => weightedDoAvg(s.filter, rk)),
          backgroundColor: s.color,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            title: { display: true, text: "%" },
            ticks: {
              callback(v) {
                return v + "%";
              },
            },
          },
        },
      },
    });
    const doAvgNote = $("#doAvgNote");
    if (doAvgNote) {
      doAvgNote.textContent = `${doQLabel} · ${doPeriodLabel} · 적립금 가중평균 · 회색 = 전체 평균`;
    }

    // 위험등급별 적립금 구성 — 당사·업권·전체 가로 100% 누적
    function doAumByRisk(filterFn) {
      const out = {};
      risks.forEach((rk) => (out[rk] = 0));
      for (const row of rows) {
        if (!filterFn(row)) continue;
        if (!out.hasOwnProperty(row.risk)) continue;
        out[row.risk] += row.aum || 0;
      }
      return out;
    }
    const aumMixLabels = ["당사", "은행", "증권", "생보", "손보", "전체"];
    const aumMixRows = [
      doAumByRisk((r) => r.name === COMPANY),
      doAumByRisk((r) => r.sector === "은행"),
      doAumByRisk((r) => r.sector === "증권"),
      doAumByRisk((r) => r.sector === "생보"),
      doAumByRisk((r) => r.sector === "손보"),
      doAumByRisk(() => true),
    ];
    const aumMixPct = (row, rk) => {
      const tot = risks.reduce((s, k) => s + (row[k] || 0), 0);
      return tot > 0 ? (row[rk] / tot) * 100 : 0;
    };
    const riskColors = {
      초저위험: "#86efac",
      저위험: "#16a34a",
      중위험: "#fbbf24",
      고위험: "#b45309",
    };
    makeChart("chartDoAum", {
      type: "bar",
      data: {
        labels: aumMixLabels,
        datasets: risks.map((rk) => ({
          label: rk,
          data: aumMixRows.map((r) => aumMixPct(r, rk)),
          backgroundColor: riskColors[rk],
          stack: "doAum",
          aumRaw: aumMixRows.map((r) => r[rk]),
        })),
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top" },
          tooltip: {
            callbacks: {
              label(ctx) {
                const rk = ctx.dataset.label;
                const pct = ctx.parsed.x;
                const aum = ctx.dataset.aumRaw[ctx.dataIndex];
                if (pct == null || Number.isNaN(pct)) return `${rk}: —`;
                return `${rk}: ${fmt(pct)}% (${aum ? fmtAum(aum / 1e8) + "억" : "—"})`;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            min: 0,
            max: 100,
            ticks: {
              stepSize: 10,
              callback(v) {
                return v + "%";
              },
            },
          },
          y: { stacked: true },
        },
      },
    });
    const doAumNote = $("#doAumNote");
    if (doAumNote) {
      doAumNote.textContent = doQ
        ? `${doQLabel} 기준 · 당사·업권·전체 위험등급 비중(100%)`
        : "당사·업권·전체 위험등급 비중(100%)";
    }

    // 수익률 추이: 당사 · 증권업 · 전체 · 경쟁사 (선택 위험등급·기간)
    const doQs = dataKeys("defaults").slice(-8);
    const doTrendSeries = [
      {
        label: "당사",
        color: "#e85d04",
        width: 2.5,
        dash: [],
        get: (q) => defaultRetOf(COMPANY, q, f.risk, f.doPeriod),
      },
      {
        label: "증권업",
        color: "#1565c0",
        width: 2,
        dash: [6, 4],
        get: (q) => defaultRetAggregate(q, f.risk, f.doPeriod, "증권"),
      },
      {
        label: "전체",
        color: "#546e7a",
        width: 2,
        dash: [2, 3],
        get: (q) => defaultRetAggregate(q, f.risk, f.doPeriod, "전체"),
      },
      ...f.competitors.map((n, i) => {
        const colors = ["#2e7d32", "#6a1b9a", "#00838f", "#ef6c00", "#ad1457", "#455a64"];
        return {
          label: n,
          color: colors[i % colors.length],
          width: 1.5,
          dash: [],
          get: (q) => defaultRetOf(n, q, f.risk, f.doPeriod),
        };
      }),
    ];
    makeChart("chartDoTrend", {
      type: "line",
      data: {
        labels: doQs,
        datasets: doTrendSeries.map((s) => ({
          label: s.label,
          data: doQs.map((q) => s.get(q)),
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: s.width,
          borderDash: s.dash,
          tension: 0.25,
          spanGaps: true,
          pointRadius: 2,
          pointHoverRadius: 4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            title: { display: true, text: "수익률 %" },
            ticks: {
              callback(v) {
                return v + "%";
              },
            },
          },
        },
      },
    });
    const doTrendNote = $("#doTrendNote");
    if (doTrendNote) {
      doTrendNote.textContent = `${f.risk} · ${doPeriodLabel} · 당사·증권업·전체 + 선택 경쟁사. 범례 클릭으로 선 on/off`;
    }

    const prevRows = doCmpQ && doCmpQ !== doQ ? state.data.defaults[doCmpQ] || [] : [];
    const prevList = Calc.aggregateDefaults(prevRows, f.risk, f.doPeriod).filter(
      (r) => f.sector === "전체" || r.sector === f.sector
    );
    Calc.assignCompetitionRanks(prevList, (r) => r.ret);
    const prevRankMap = new Map(prevList.map((x) => [x.name, x.rank]));

    const doPeriodCols = [
      { key: "1m", field: "r1m", label: "1개월" },
      { key: "3m", field: "r3m", label: "3개월" },
      { key: "6m", field: "r6m", label: "6개월" },
      { key: "1y", field: "r1y", label: "1년" },
      { key: "3y", field: "r3y", label: "3년" },
    ];
    const sortCol = doPeriodCols.find((c) => c.key === f.doPeriod) || doPeriodCols[3];

    let sectorAvg = null;
    if (list.length) {
      const den = list.reduce((a, b) => a + (b.aum || 0), 0);
      sectorAvg = den
        ? list.reduce((a, b) => a + b.ret * (b.aum || 0), 0) / den
        : list.reduce((a, b) => a + b.ret, 0) / list.length;
    }

    const sectorLabel = f.sector === "전체" ? "전체" : f.sector;
    const cmpLabel = cmpPeriodNote("defaults", f.cmpQ);

    const titleEl = $("#doRankTitle");
    if (titleEl) {
      titleEl.innerHTML = `${sectorLabel} 디폴트옵션 순위표 · ${doQLabel} · ${f.risk} <button class="btn" data-export-table="tblDo" data-filename="디폴트순위.xlsx">엑셀</button>`;
    }

    let html = `<table class="data do-rank-table" id="tblDo"><thead><tr>
      <th>순위</th>
      <th class="left">사업자</th>
      <th>적립금(억원)</th>
      ${doPeriodCols
        .map(
          (c) =>
            `<th>${c.label}${c.key === sortCol.key ? ' <span class="sort-mark">●</span>' : ""}</th>`
        )
        .join("")}
      <th>평균 대비</th>
    </tr></thead><tbody>`;

    for (const r of list) {
      const prevRank = prevRankMap.has(r.name) ? prevRankMap.get(r.name) : null;
      const isMe = r.name === COMPANY;
      const isComp = f.competitors.includes(r.name);
      const cls = isMe ? "me" : isComp ? "comp" : "";
      const d = Calc.deltaRank(r.rank, prevRank);
      let deltaCell;
      if (prevRank == null) {
        deltaCell = `<span class="delta-new">신규</span>`;
      } else {
        const fd = Calc.formatDelta(d);
        deltaCell = `<span class="${fd.cls}">${fd.text}</span>`;
      }
      const nameCell = `${isComp ? '<span class="comp-mark">●</span>' : ""}${r.name}`;
      const gap = sectorAvg == null ? null : r.ret - sectorAvg;
      let gapHtml = "—";
      if (gap != null) {
        const gapCls = gap > 0.005 ? "gap-plus" : gap < -0.005 ? "gap-minus" : "gap-zero";
        const sign = gap > 0 ? "+" : "";
        gapHtml = `<span class="do-gap ${gapCls}">${sign}${fmt(gap)}%p</span>`;
      }
      html += `<tr class="${cls}">
        <td class="rank-cell"><span class="rank-num">${r.rank}</span> ${deltaCell}</td>
        <td class="left">${nameCell}</td>
        <td>${fmtAum((r.aum || 0) / 1e8)}</td>
        ${doPeriodCols
          .map((c) => {
            const v = r.rets ? r.rets[c.field] : c.key === sortCol.key ? r.ret : null;
            const mark = c.key === sortCol.key ? ' class="sort-col"' : "";
            return `<td${mark}>${fmt(v)}</td>`;
          })
          .join("")}
        <td>${gapHtml}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    $("#doRank").innerHTML = html;
    $("#doNote").textContent =
      `${doQLabel} · ${sortCol.label} 수익률 기준 순위(●) · ${sectorLabel} 평균 ${fmt(sectorAvg)}% · 변동은 ${cmpLabel} 대비 · 누적 수익률(연환산 아님)`;
  }

  function renderFees() {
    const f = state.filters;
    const feeYear = feesYearFor(f.feeYear) || f.feeYear;
    const feeCmpYear = f.feeCmpYear ? feesYearFor(f.feeCmpYear) : null;
    const retKeys = dataKeys("returns");
    const baseQ = hasPeriodData("returns", f.baseQ)
      ? f.baseQ
      : retKeys[retKeys.length - 1] || f.baseQ;
    const rows = state.data.fees[feeYear] || [];
    const list = Calc.rankFees(rows, f.feePlan, f.feeSector);
    const prevList = feeCmpYear
      ? Calc.rankFees(state.data.fees[feeCmpYear] || [], f.feePlan, f.feeSector)
      : [];

    const sectors = ["은행", "증권", "생보", "손보"];
    const sectorColors = {
      은행: "#3b82f6",
      증권: "#7c3aed",
      생보: "#16a34a",
      손보: "#ca8a04",
    };
    const feePlans = ["DB", "DC", "IRP"];

    function meanRate(sub) {
      if (!sub.length) return null;
      return sub.reduce((s, r) => s + r.rate, 0) / sub.length;
    }
    function avgParts(sub) {
      if (!sub.length) return null;
      const split = sub.filter((r) => r.ops != null && r.asset != null);
      if (split.length) {
        return {
          ops: split.reduce((s, r) => s + r.ops, 0) / split.length,
          asset: split.reduce((s, r) => s + r.asset, 0) / split.length,
          rate: split.reduce((s, r) => s + r.rate, 0) / split.length,
          hasSplit: true,
        };
      }
      return {
        ops: null,
        asset: null,
        rate: meanRate(sub),
        hasSplit: false,
      };
    }

    // 1) 업권 평균: DB·DC·IRP × 은행/증권/생보/손보 + 당사
    const avgTitle = $("#feeAvgTitle");
    if (avgTitle) {
      avgTitle.innerHTML = `수수료 비용부담률 업권 평균 (${feeYear || "—"}년) <button class="btn" data-export-chart="chartFeeAvg" data-filename="수수료업권평균.png">PNG</button>`;
    }
    makeChart("chartFeeAvg", {
      type: "bar",
      _decimals: 3,
      data: {
        labels: feePlans,
        datasets: [
          ...sectors.map((s) => ({
            label: `${s} 평균`,
            data: feePlans.map((pl) => meanRate(Calc.rankFees(rows, pl, s))),
            backgroundColor: sectorColors[s],
          })),
          {
            label: "당사",
            data: feePlans.map((pl) => {
              const parts = Calc.feeParts(
                rows.find((r) => r.name === COMPANY),
                pl
              );
              return parts ? parts.rate : null;
            }),
            backgroundColor: "#e85d04",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "%" },
            ticks: {
              callback(v) {
                return v + "%";
              },
            },
          },
        },
      },
    });
    const feeAvgNote = $("#feeAvgNote");
    if (feeAvgNote) {
      feeAvgNote.textContent = `${feeYear || "—"}년 · 제도별 단순평균 · 낮을수록 좋음`;
    }

    // 2) 수수료 구성: 당사 + 경쟁사 + 증권평균 + 전체평균 (가로 누적)
    const mixPlan = f.feePlan;
    const secList = Calc.rankFees(rows, mixPlan, "증권");
    const allList = Calc.rankFees(rows, mixPlan, "전체");
    const mixRows = [];
    const meRow = allList.find((r) => r.name === COMPANY);
    if (meRow) mixRows.push({ label: meRow.name, ...meRow, kind: "me" });
    f.competitors.forEach((n) => {
      const hit = allList.find((r) => r.name === n);
      if (hit) mixRows.push({ label: hit.name, ...hit, kind: "comp" });
    });
    mixRows.sort((a, b) => a.rate - b.rate);
    const secAvgP = avgParts(secList);
    const allAvgP = avgParts(allList);
    if (secAvgP) mixRows.push({ label: "증권 평균", ...secAvgP, kind: "secAvg" });
    if (allAvgP) mixRows.push({ label: "전체 평균", ...allAvgP, kind: "allAvg" });
    const hasSplit = mixRows.some((r) => r.hasSplit || (r.ops != null && r.asset != null));
    const mixTitle = $("#feeMixTitle");
    if (mixTitle) {
      mixTitle.innerHTML = `수수료 구성 (${feeYear || "—"}년) <button class="btn" data-export-chart="chartFeeMix" data-filename="수수료구성.png">PNG</button>`;
    }
    makeChart("chartFeeMix", {
      type: "bar",
      _decimals: 3,
      data: {
        labels: mixRows.map((r) => r.label),
        datasets: hasSplit
          ? [
              {
                label: "운용관리",
                data: mixRows.map((r) => (r.ops != null ? r.ops : null)),
                backgroundColor: "#93c5fd",
                stack: "fee",
              },
              {
                label: "자산관리",
                data: mixRows.map((r) => (r.asset != null ? r.asset : null)),
                backgroundColor: "#1e3a5f",
                stack: "fee",
              },
            ]
          : [
              {
                label: "총비용부담률",
                data: mixRows.map((r) => r.rate),
                backgroundColor: mixRows.map((r) =>
                  r.kind === "me" ? "#e85d04" : r.kind === "comp" ? "#0d9488" : "#64748b"
                ),
              },
            ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: {
            stacked: hasSplit,
            beginAtZero: true,
            title: { display: true, text: "%" },
            ticks: {
              callback(v) {
                return v + "%";
              },
            },
          },
          y: { stacked: hasSplit },
        },
      },
    });
    const feeMixNote = $("#feeMixNote");
    if (feeMixNote) {
      feeMixNote.textContent = hasSplit
        ? `${mixPlan} · 운용관리 + 자산관리 · 짧을수록 좋음`
        : `${mixPlan} · 총비용만 표시(운용·자산 분리 없음) · 수수료 엑셀 재업로드 시 구성 표시 · 짧을수록 좋음`;
    }

    // 3) 전년 대비: 업권 사업자 + 업권 평균(맨 아래)
    const yKeys = dataKeys("fees");
    const yoyPrev =
      feeCmpYear ||
      (feeYear && yKeys.includes(String(Number(feeYear) - 1))
        ? String(Number(feeYear) - 1)
        : yKeys.filter((y) => y < feeYear).slice(-1)[0] || null);
    const yoySec = f.feeSector === "전체" ? "증권" : f.feeSector;
    const curSecList = Calc.rankFees(rows, f.feePlan, yoySec);
    const prevSecList = yoyPrev ? Calc.rankFees(state.data.fees[yoyPrev] || [], f.feePlan, yoySec) : [];
    const prevByName = new Map(prevSecList.map((r) => [r.name, r.rate]));
    const yoyItems = curSecList
      .map((r) => {
        const prev = prevByName.has(r.name) ? prevByName.get(r.name) : null;
        if (prev == null) return null;
        return {
          name: r.name,
          delta: r.rate - prev,
          isMe: r.name === COMPANY,
          isComp: f.competitors.includes(r.name),
          kind: "prov",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.delta - b.delta);
    if (yoyPrev && curSecList.length && prevSecList.length) {
      const curAvg = meanRate(curSecList);
      const prevAvg = meanRate(prevSecList);
      if (curAvg != null && prevAvg != null) {
        yoyItems.push({
          name: `${yoySec} 평균`,
          delta: curAvg - prevAvg,
          isMe: false,
          isComp: false,
          kind: "avg",
        });
      }
    }
    const yoyTitle = $("#feeYoYTitle");
    if (yoyTitle) {
      yoyTitle.innerHTML = `전년 대비 수수료 변화 (${yoyPrev || "—"}→${feeYear || "—"}년) <button class="btn" data-export-chart="chartFeeYoY" data-filename="수수료전년대비.png">PNG</button>`;
    }
    makeChart("chartFeeYoY", {
      type: "bar",
      _decimals: 3,
      _suffix: "%p",
      data: {
        labels: yoyItems.map((r) => r.name),
        datasets: [
          {
            label: "전년 대비",
            data: yoyItems.map((r) => r.delta),
            backgroundColor: yoyItems.map((r) =>
              r.kind === "avg"
                ? "#7c3aed"
                : r.isMe
                ? "#e85d04"
                : r.isComp
                ? "#0d9488"
                : "#cbd5e1"
            ),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.x;
                if (v == null || Number.isNaN(+v)) return "—";
                const sign = v > 0 ? "+" : "";
                return sign + fmt(+v, 3) + "%p";
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: "%p" },
            ticks: {
              callback(v) {
                return v + "%p";
              },
            },
          },
        },
      },
    });
    const feeYoYNote = $("#feeYoYNote");
    if (feeYoYNote) {
      const meYoy = yoyItems.find((r) => r.isMe);
      const avgYoy = yoyItems.find((r) => r.kind === "avg");
      const meTxt =
        meYoy != null ? `당사 ${meYoy.delta > 0 ? "+" : ""}${fmt(meYoy.delta, 3)}%p` : "당사 —";
      const avgTxt =
        avgYoy != null
          ? `${yoySec} 평균 ${avgYoy.delta > 0 ? "+" : ""}${fmt(avgYoy.delta, 3)}%p`
          : "";
      feeYoYNote.textContent = yoyPrev
        ? `${yoySec} · ${f.feePlan} · 왼쪽(음수)일수록 인하 · ${meTxt}${avgTxt ? ", " + avgTxt : ""}`
        : "비교할 이전 연도 수수료 데이터가 없습니다.";
    }

    // 적립금: 수익률 공시(기준분기 또는 최신)의 선택 제도 합계
    const aumQ = baseQ || dataKeys("returns").slice(-1)[0] || null;
    const aumIndexed = Calc.indexReturns(state.data.returns[aumQ] || []);

    let feeAvg = null;
    if (list.length) {
      feeAvg = list.reduce((a, b) => a + b.rate, 0) / list.length;
    }
    const prevRankMap = new Map(prevList.map((x) => [x.name, x.rank]));
    const sectorLabel = f.feeSector === "전체" ? "전체" : f.feeSector;
    const cmpLabel = feeCmpYear ? `${feeCmpYear}년` : "비교연도 없음";
    const aumColLabel = `${f.feePlan} 적립금(억원)`;

    const feeTitle = $("#feeRankTitle");
    if (feeTitle) {
      feeTitle.innerHTML = `${sectorLabel} 수수료 순위표 · ${feeYear || "—"} · ${f.feePlan} <button class="btn" data-export-table="tblFee" data-filename="수수료순위.xlsx">엑셀</button>`;
    }
    const feeNote = $("#feeNote");
    if (feeNote) {
      feeNote.textContent = `수수료 낮을수록 1위 · ${sectorLabel} 평균 ${fmt(feeAvg, 2)}% · 변동은 ${cmpLabel} 대비 · 적립금은 ${
        aumQ ? formatPeriodLabel(aumQ) : "—"
      } ${f.feePlan} 기준`;
    }

    function feeGapHtml(v) {
      if (v == null || Number.isNaN(v)) return "—";
      const cls = v > 0.0005 ? "gap-plus" : v < -0.0005 ? "gap-minus" : "gap-zero";
      const sign = v > 0 ? "+" : "";
      return `<span class="do-gap ${cls}">${sign}${fmt(v, 2)}%p</span>`;
    }

    let html = `<table class="data do-rank-table" id="tblFee"><thead><tr>
      <th>순위</th>
      <th class="left">사업자</th>
      <th>수수료 비용부담률</th>
      <th>평균 대비</th>
      <th>${aumColLabel}</th>
    </tr></thead><tbody>`;

    for (const r of list) {
      const prevRank = prevRankMap.has(r.name) ? prevRankMap.get(r.name) : null;
      const isMe = r.name === COMPANY;
      const isComp = f.competitors.includes(r.name);
      const cls = isMe ? "me" : isComp ? "comp" : "";
      let deltaCell;
      if (prevRank == null) {
        deltaCell = f.feeCmpYear ? `<span class="delta-new">신규</span>` : "";
      } else {
        const fd = Calc.formatDelta(Calc.deltaRank(r.rank, prevRank));
        deltaCell = `<span class="${fd.cls}">${fd.text}</span>`;
      }
      const gap = feeAvg == null ? null : r.rate - feeAvg;
      const aum = Calc.totalAum(aumIndexed.get(r.name), f.feePlan);
      const nameCell = `${isComp ? '<span class="comp-mark">●</span>' : ""}${r.name}`;
      html += `<tr class="${cls}">
        <td class="rank-cell"><span class="rank-num">${r.rank}</span> ${deltaCell}</td>
        <td class="left">${nameCell}</td>
        <td>${fmt(r.rate, 2)}</td>
        <td>${feeGapHtml(gap)}</td>
        <td>${aum == null ? "—" : fmtAum(aum)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    $("#feeRank").innerHTML = html;
  }

  function renderDataPage() {
    if (!isEditor()) {
      state.page = "summary";
      renderPage();
      return;
    }
    const sources = state.data.sources || {};
    const keys = Object.keys(sources).sort();
    let html = `<table class="data" id="tblSources"><thead><tr><th class="left">구분</th><th class="left">파일</th><th>행 수</th><th>종류</th><th></th></tr></thead><tbody>`;
    for (const k of keys) {
      const s = sources[k];
      const tag =
        s.kind === "공시" ? "ok" : s.kind === "예시" ? "warn" : "mix";
      html += `<tr><td class="left">${k}</td><td class="left">${s.file || "—"}</td><td>${s.rows || 0}</td><td><span class="tag ${tag}">${s.kind}</span></td>`;
      html += `<td><button class="btn" data-del="${k}">삭제</button></td></tr>`;
    }
    html += `</tbody></table>`;
    $("#sourceList").innerHTML = html;
    $$("#sourceList [data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.del;
        if (!confirm(`${key} 데이터를 삭제할까요?`)) return;
        const [kind, id] = key.split(":");
        if (kind === "returns") delete state.data.returns[id];
        if (kind === "defaults") delete state.data.defaults[id];
        if (kind === "fees") delete state.data.fees[id];
        delete state.data.sources[key];
        persistData();
        syncFilterControls();
        renderDataPage();
        toast("삭제되었습니다.");
      });
    });
    const at = formatUpdatedAt(state.data.meta.updatedAt) || state.data.meta.updatedAt || "—";
    $("#dataMeta").textContent = `최종 갱신: ${at} · 수익률 ${Object.keys(state.data.returns).length}분기 · 디폴트 ${Object.keys(state.data.defaults).length}분기 · 수수료 ${Object.keys(state.data.fees).length}년`;
    updateHeaderMeta();
  }

  let pendingUploads = [];

  function showValidateModal(parsedList) {
    pendingUploads = parsedList;
    const lines = parsedList.map((p) => {
      const kindLabel =
        p.kind === "returns" ? "수익률" : p.kind === "defaults" ? "디폴트옵션" : "수수료";
      const keyHint =
        p.keySource === "filename" ? " (파일명)" : p.keySource === "input" ? " (입력)" : "";
      return `· ${p.fileName} → ${kindLabel} ${p.key || "(키 없음)"}${keyHint} · 인식 ${p.rows.length}행 · 문제 ${p.problems.length}건 · 스킵 ${p.skipped || 0}`;
    });
    const hardIssues = parsedList.flatMap((p) =>
      (p.issues || []).map((msg) => `${p.fileName}: ${msg}`)
    );
    const blockReasons = [];
    parsedList.forEach((p) => {
      if (!p.key) blockReasons.push(`${p.fileName}: 분기/연도 키가 없습니다. 위에 입력 후 다시 올려 주세요.`);
      if (!p.rows.length) blockReasons.push(`${p.fileName}: 인식된 데이터 행이 없습니다.`);
    });
    hardIssues.forEach((msg) => blockReasons.push(msg));

    const canSave =
      parsedList.every((p) => p.key && p.rows.length) && hardIssues.length === 0;

    $("#validateSummary").innerHTML =
      `<strong>검증 결과</strong><br>${lines.join("<br>")}` +
      (blockReasons.length
        ? `<br><br><strong style="color:#c62828">저장 불가 사유</strong><br><span style="color:#c62828">${blockReasons.join("<br>")}</span>`
        : `<br><br><span style="color:#2e7d32">저장 가능합니다. (이 PC 브라우저에만 반영)</span>`);

    const allProblems = parsedList.flatMap((p) =>
      (p.problems || []).map((pr) => ({ ...pr, file: p.fileName }))
    );
    if (!allProblems.length) {
      $("#validateProblems").innerHTML = canSave
        ? '<p class="note" style="margin:0">행 단위 문제 없음.</p>'
        : '<p class="note" style="margin:0">행 단위 문제는 없으나, 위 저장 불가 사유를 해결해야 저장됩니다.</p>';
    } else {
      let ph = `<table class="data"><thead><tr><th>파일</th><th>엑셀행</th><th class="left">사업자</th><th class="left">사유</th><th class="left">상세</th></tr></thead><tbody>`;
      allProblems.slice(0, 80).forEach((pr) => {
        ph += `<tr><td>${pr.file || ""}</td><td>${pr.row || ""}</td><td class="left">${pr.name || ""}</td><td class="left">${pr.reason || ""}</td><td class="left">${pr.detail || ""}</td></tr>`;
      });
      if (allProblems.length > 80) {
        ph += `<tr><td colspan="5" class="left">… 외 ${allProblems.length - 80}건</td></tr>`;
      }
      ph += `</tbody></table>`;
      $("#validateProblems").innerHTML = ph;
    }

    $("#validateSave").disabled = !canSave;
    $("#validateSave").textContent = canSave
      ? allProblems.length
        ? `문제 ${allProblems.length}건 있으나 인식 행만 저장`
        : "검증 통과 · 저장"
      : "저장 불가";
    $("#modalValidate").classList.add("show");
  }

  function commitPendingUploads() {
    if (!pendingUploads.length) return;
    for (const parsed of pendingUploads) {
      if (!parsed.key || !parsed.rows.length) continue;
      const storeKey =
        parsed.kind === "returns"
          ? "returns"
          : parsed.kind === "defaults"
          ? "defaults"
          : "fees";
      state.data[storeKey][parsed.key] = parsed.rows;
      const srcId = `${storeKey}:${parsed.key}`;
      state.data.sources[srcId] = {
        file: parsed.fileName,
        kind: "공시",
        rows: parsed.rows.length,
        problems: (parsed.problems || []).length,
      };
    }
    persistData();
    syncFilterControls();
    renderDataPage();
    toast(`${pendingUploads.length}개 파일 저장 완료`);
    pendingUploads = [];
    $("#modalValidate").classList.remove("show");
  }

  async function handleUpload(files, kind, key) {
    if (!isEditor()) return toast("관리자만 업로드할 수 있습니다.");
    const parsedList = [];
    const keyNorm = key ? Parser.normalizePeriodKey(key, kind) : null;
    for (const file of files) {
      // 입력값 > 파일명(242Q 등) > 엑셀 본문 순으로 parseFile이 키 결정
      const parsed = await Parser.parseFile(file, { kind, key: keyNorm || undefined });
      if (keyNorm) parsed.key = keyNorm;
      parsedList.push(parsed);
    }
    if (!parsedList.length) return toast("파일이 없습니다.");
    showValidateModal(parsedList);
  }

  function downloadDeployBundle() {
    const blob = new Blob(
      [
        "/* deployed store */\nwindow.APP_DATA = " +
          JSON.stringify(state.data) +
          ";\n",
      ],
      { type: "application/javascript;charset=utf-8" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "data-store.js";
    a.click();
    toast("배포용 data-store.js를 내려받았습니다. 서버의 js/data-store.js를 교체하세요.");
  }

  const PAGE_LABELS = {
    summary: "요약",
    sector: "업권별",
    plan: "제도별",
    period: "기간별",
    defaults: "디폴트옵션",
    fees: "수수료",
    data: "데이터관리",
  };

  /** A4 세로(210×297mm). 카드(항목) 단위로 페이지에 배치해 중간 잘림 방지 */
  const PDF_A4 = { orientation: "portrait", unit: "mm", format: "a4" };
  const PDF_MARGIN_MM = 10;
  const PDF_GAP_MM = 5;
  const PDF_CAPTURE_CSS_W = 980;
  const PDF_SCALE = 2.5;

  function pdfPageInnerMm(pdf) {
    const w = pdf.internal.pageSize.getWidth();
    const h = pdf.internal.pageSize.getHeight();
    return { w: w - PDF_MARGIN_MM * 2, h: h - PDF_MARGIN_MM * 2, pageW: w, pageH: h };
  }

  /** jsPDF 기본 폰트는 한글 미지원 → 캔버스에 시스템 한글 폰트로 제목 그림 */
  function drawPdfTitleBanner(widthPx, title, subtitle) {
    const scale = PDF_SCALE;
    const h = Math.round(52 * scale);
    const c = document.createElement("canvas");
    c.width = widthPx;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0f2744";
    ctx.fillRect(0, 0, widthPx, h);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    const fontStack = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif';
    ctx.font = `bold ${20 * scale}px ${fontStack}`;
    ctx.fillText(title, 14 * scale, h * 0.4);
    if (subtitle) {
      ctx.font = `${13 * scale}px ${fontStack}`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(subtitle, 14 * scale, h * 0.72);
    }
    return c;
  }

  async function captureElement(el, bg) {
    const w = Math.ceil(Math.max(el.scrollWidth, el.offsetWidth, el.clientWidth, 1));
    const h = Math.ceil(Math.max(el.scrollHeight, el.offsetHeight, el.clientHeight, 1));
    return html2canvas(el, {
      scale: PDF_SCALE,
      useCORS: true,
      allowTaint: true,
      backgroundColor: bg,
      logging: false,
      scrollX: -window.scrollX,
      scrollY: -window.scrollY,
      width: w,
      height: h,
      windowWidth: Math.max(w, PDF_CAPTURE_CSS_W),
      windowHeight: h,
      x: 0,
      y: 0,
      imageTimeout: 15000,
      onclone(doc) {
        const body = doc.body;
        if (!body) return;
        body.style.fontFamily = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif';
        body.querySelectorAll("*").forEach((node) => {
          if (node.style) node.style.fontFamily = "inherit";
        });
      },
    });
  }

  /** 페이지를 PDF 블록 단위로 분리 (제목·KPI행·카드 등 — 중간에서 안 자름) */
  function collectPdfBlockEls(pageEl) {
    const blocks = [];
    const head = pageEl.querySelector(":scope > .page-head");
    if (head) blocks.push(head);
    const grid = pageEl.querySelector(":scope > .grid");
    if (!grid) {
      if (!blocks.length) blocks.push(pageEl);
      return blocks;
    }
    [...grid.children].forEach((child) => {
      if (child.nodeType !== 1) return;
      // KPI 행·카드·기타 섹션을 각각 하나의 항목으로
      blocks.push(child);
    });
    return blocks.length ? blocks : [pageEl];
  }

  function padCanvasToWidth(canvas, widthPx, bg) {
    if (canvas.width >= widthPx) return canvas;
    const out = document.createElement("canvas");
    out.width = widthPx;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = bg || "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  /** 항목(캔버스)을 세로 A4에 배치 — 한 항목이 페이지를 넘으면 통째로 다음 장, 한 장보다 크면 축소 */
  function addBlockCanvasesToPdf(pdf, canvases) {
    const { w: usableW, h: usableH } = pdfPageInnerMm(pdf);
    let yMm = PDF_MARGIN_MM;
    let started = false;

    canvases.forEach((canvas) => {
      if (!canvas || !canvas.width || !canvas.height) return;
      let drawW = usableW;
      let drawH = (canvas.height / canvas.width) * drawW;
      if (drawH > usableH) {
        const s = usableH / drawH;
        drawW *= s;
        drawH = usableH;
      }

      const needNewPage = started && yMm + drawH > PDF_MARGIN_MM + usableH + 0.1;
      if (needNewPage) {
        pdf.addPage();
        yMm = PDF_MARGIN_MM;
      }
      started = true;

      const x = PDF_MARGIN_MM + (usableW - drawW) / 2;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      pdf.addImage(dataUrl, "JPEG", x, yMm, drawW, drawH, undefined, "FAST");
      yMm += drawH + PDF_GAP_MM;
    });
  }

  async function exportPagePdf() {
    if (state.page === "data") {
      toast("데이터 관리 페이지는 PDF로 저장하지 않습니다.");
      return;
    }
    if (typeof html2canvas !== "function" || !window.jspdf) {
      toast("PDF 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
      return;
    }
    const filterEl = $("#filterCommon");
    const pageEl = $(`#page-${state.page}`);
    if (!pageEl) return;

    const btn = $("#btnPdf");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "PDF 생성 중…";
    }
    toast("PDF 생성 중… 항목별 분할 · A4 세로");

    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);
    document.body.classList.add("capturing-pdf");

    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 220)));

      const q =
        state.page === "fees"
          ? state.filters.feeYear || ""
          : state.filters.baseQ || state.filters.feeYear || "";
      const pageLabel = PAGE_LABELS[state.page] || state.page;
      const titleMain = "한화투자증권 퇴직연금 공시 비교";
      const titleSub = `${pageLabel}${q ? " · " + q : ""} · A4 세로`;

      const blockEls = collectPdfBlockEls(pageEl);
      const canvases = [];

      // 필터
      if (filterEl && !filterEl.classList.contains("hidden")) {
        canvases.push(await captureElement(filterEl, "#ffffff"));
      }

      // 페이지 제목·KPI·카드 각각 캡처 (중간 절단 없음)
      for (const el of blockEls) {
        if (!el || el.offsetParent === null && el.offsetHeight === 0) continue;
        const bg = el.classList.contains("page-head") ? "#f4f6f8" : "#ffffff";
        canvases.push(await captureElement(el, bg));
      }

      if (!canvases.length) throw new Error("캡처할 항목이 없습니다.");

      const maxW = Math.max(...canvases.map((c) => c.width));
      const cTitle = drawPdfTitleBanner(maxW, titleMain, titleSub);
      const normalized = [cTitle, ...canvases.map((c) => padCanvasToWidth(c, maxW, "#ffffff"))];

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF(PDF_A4);
      addBlockCanvasesToPdf(pdf, normalized);
      const fname = `퇴직연금_${pageLabel}_${q || "report"}_A4.pdf`;
      pdf.save(fname);
      toast("A4 PDF를 저장했습니다. (항목별 잘림 방지)");
    } catch (e) {
      console.error(e);
      toast("PDF 생성 실패: " + (e.message || e));
    } finally {
      document.body.classList.remove("capturing-pdf");
      window.scrollTo(prevScrollX, prevScrollY);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "PDF 저장";
      }
    }
  }

  function renderPage() {
    $$(".page").forEach((p) => p.classList.remove("active"));
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === state.page));
    const page = $(`#page-${state.page}`);
    if (page) page.classList.add("active");
    const pdfBtn = $("#btnPdf");
    if (pdfBtn) {
      pdfBtn.style.display = state.page === "data" ? "none" : "";
    }
    applyFilterVisibility();
    if (state.page !== "data") {
      syncFilterControls();
      renderCompetitors();
    }
    try {
      if (state.page === "summary") renderSummary();
      else if (state.page === "sector") renderSector();
      else if (state.page === "plan") renderPlan();
      else if (state.page === "period") renderPeriod();
      else if (state.page === "defaults") renderDefaults();
      else if (state.page === "fees") renderFees();
      else if (state.page === "data") renderDataPage();
    } catch (e) {
      console.error(e);
      toast("화면 렌더 오류: " + e.message);
    }
  }

  function bind() {
    $$(".nav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page === "data" && !isEditor()) {
          toast("데이터 관리는 관리자 모드에서만 볼 수 있습니다.");
          return;
        }
        state.page = btn.dataset.page;
        applyLatestPeriodForPage();
        renderPage();
      });
    });
    // 기준·비교 분기는 각각 독립 선택 (한쪽 바꿔도 다른 쪽 자동 변경 없음)
    $("#filterCommon").addEventListener("change", (e) => {
      readFiltersFromUI();
      renderPage();
    });
    $("#btnEditor").addEventListener("click", () => {
      if (isEditor()) {
        setEditor(false);
        toast("일반 보기 모드로 전환되었습니다.");
        return;
      }
      $("#modalAuth").classList.add("show");
      $("#authPass").value = "";
      $("#authPass").focus();
    });
    $("#authCancel").addEventListener("click", () => $("#modalAuth").classList.remove("show"));
    $("#authOk").addEventListener("click", () => {
      if ($("#authPass").value === EDITOR_PASS) {
        setEditor(true);
        $("#modalAuth").classList.remove("show");
        toast("관리자 모드입니다. 데이터 관리 메뉴가 열립니다.");
      } else toast("비밀번호가 올바르지 않습니다.");
    });
    $("#validateCancel").addEventListener("click", () => {
      pendingUploads = [];
      $("#modalValidate").classList.remove("show");
    });
    $("#validateSave").addEventListener("click", () => commitPendingUploads());

    $("#btnCompPick")?.addEventListener("click", () => openCompModal());
    $("#modalComp")?.addEventListener("click", (e) => {
      if (e.target === $("#modalComp")) closeCompModal();
    });
    $("#btnCompDefault")?.addEventListener("click", () => {
      draftCompetitors = (state.data.meta.competitors_default || []).slice(0, MAX_COMPETITORS);
      renderCompPicker();
    });
    $("#btnCompApply")?.addEventListener("click", () => {
      state.filters.competitors = [...draftCompetitors];
      saveCompetitors();
      updateCompTriggerLabel();
      closeCompModal();
      refreshCompPage();
      toast(`경쟁사 ${draftCompetitors.length}곳 적용`);
    });

    // upload zones
    const zone = $("#uploadZone");
    const fileInput = $("#fileInput");
    $("#btnPickFile").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const kind = $("#uploadKind").value;
      const key = $("#uploadKey").value.trim() || undefined;
      handleUpload([...fileInput.files], kind === "auto" ? undefined : kind, key);
      fileInput.value = "";
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
      const kind = $("#uploadKind").value;
      const key = $("#uploadKey").value.trim() || undefined;
      handleUpload([...e.dataTransfer.files], kind === "auto" ? undefined : kind, key);
    });

    $("#btnPdf").addEventListener("click", () => exportPagePdf());
    $("#btnExportStore").addEventListener("click", downloadDeployBundle);
    $("#btnClearLocal").addEventListener("click", () => {
      if (!confirm("이 PC의 로컬 저장 데이터를 지우고 배포본(data-store.js)만 볼까요?")) return;
      localStorage.removeItem(LS_DATA);
      loadData();
      syncFilterControls();
      renderPage();
      toast("로컬 저장을 지웠습니다. 배포본만 표시합니다.");
    });

    // export buttons via delegation
    document.body.addEventListener("click", (e) => {
      const t = e.target.closest("[data-export-chart]");
      if (t) exportChartPng(t.dataset.exportChart, t.dataset.filename);
      const x = e.target.closest("[data-export-table]");
      if (x) exportTableXlsx(x.dataset.exportTable, x.dataset.filename);
    });

  }

  function init() {
    loadData();
    state.editor = localStorage.getItem(LS_EDIT) === "1";
    $("#editorBadge").style.display = state.editor ? "inline-flex" : "none";
    $("#editorBadge").textContent = "관리자";
    $("#btnEditor").textContent = state.editor ? "관리자 모드 종료" : "관리자 로그인";
    const navData = $("#navData");
    if (navData) navData.style.display = state.editor ? "" : "none";
    bind();
    syncFilterControls();
    renderPage();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
