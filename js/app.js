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
  /** 적립금(억): 1,000억 이상은 조 단위 (1조=10,000억) */
  function fmtAum(n, d = 2) {
    if (n == null || Number.isNaN(+n)) return "—";
    const v = +n;
    if (Math.abs(v) >= 1000) {
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
  function fmtPp(n) {
    if (n == null) return "—";
    const s = (n >= 0 ? "+" : "") + fmt(n);
    return s + "%p";
  }

  function defaultsQuarterFor(baseQ) {
    const keys = Calc.sortQuarters(Object.keys(state.data.defaults || {}));
    if (!keys.length) return null;
    if (baseQ && state.data.defaults[baseQ]) return baseQ;
    // 기준 분기 이전이면 가장 가까운 이전 분기
    if (baseQ) {
      const earlier = keys.filter((k) => k <= baseQ);
      if (earlier.length) return earlier[earlier.length - 1];
    }
    return keys[keys.length - 1];
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

  function loadData() {
    let base = window.APP_DATA ? JSON.parse(JSON.stringify(window.APP_DATA)) : {
      meta: { company: COMPANY, competitors_default: [] },
      returns: {},
      defaults: {},
      fees: {},
      sources: {},
    };
    try {
      const raw = localStorage.getItem(LS_DATA);
      if (raw) {
        const local = JSON.parse(raw);
        if (local && local.returns) base = local;
      }
    } catch (e) {
      console.warn(e);
    }
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
    const qs = Calc.sortQuarters(Object.keys(base.returns || {}));
    // 기준·비교 분기는 사용자가 자유롭게 선택 (최초 로드 시에만 기본값)
    if (!state.filters.baseQ || !qs.includes(state.filters.baseQ)) {
      state.filters.baseQ = qs[qs.length - 1] || null;
    }
    if (state.filters.cmpQ && !qs.includes(state.filters.cmpQ)) {
      state.filters.cmpQ = null;
    }
    if (state.filters.cmpQ == null && qs.length > 1) {
      const bi = qs.indexOf(state.filters.baseQ);
      state.filters.cmpQ = bi > 0 ? qs[bi - 1] : qs[qs.length - 2];
    }
    const ys = Object.keys(base.fees || {}).sort();
    state.filters.feeYear = ys[ys.length - 1] || null;
    state.filters.feeCmpYear = ys.length > 1 ? ys[ys.length - 2] : null;
  }

  function persistData() {
    state.data.meta.updatedAt = new Date().toISOString();
    localStorage.setItem(LS_DATA, JSON.stringify(state.data));
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
    const qs = Calc.sortQuarters(Object.keys(state.data.returns || {}));
    const qOpts = qs.map((q) => [q, q.replace("Q", "년 ") + "분기"]);
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
    const ys = Object.keys(state.data.fees || {}).sort();
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
    const rows = state.data.returns[f.baseQ] || [];
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
    const showQuarter = showRet || showDo || showFee;
    const showSector = ["summary", "sector", "plan", "period", "defaults"].includes(p);
    const showCompPick = showRet || showDo;
    $("#filterCommon").classList.toggle("hidden", p === "data");
    $$(".only-quarter").forEach((el) => el.classList.toggle("hidden", !showQuarter));
    $$(".only-common").forEach((el) => {
      if (el.classList.contains("competitor-field")) {
        el.classList.toggle("hidden", !showCompPick);
      } else if (el.classList.contains("only-fee-y")) {
        el.classList.toggle("hidden", !(showRet || showFee));
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
    const indexed = Calc.indexReturns(state.data.returns[f.baseQ] || []);
    const ranked = Calc.rankList(indexed, {
      plan: f.plan,
      type: f.type,
      period: f.period,
      sector: f.sector,
      minAum: f.minAum,
      avgMode: f.avgMode,
    });
    const me = Calc.findRank(ranked, COMPANY);
    const prevIndexed = f.cmpQ ? Calc.indexReturns(state.data.returns[f.cmpQ] || []) : null;
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

    // total aum securities / all
    let sectorAum = 0;
    let myAum = 0;
    for (const e of indexed.values()) {
      if (f.sector !== "전체" && e.sector !== f.sector) continue;
      const t = Calc.totalAum(e, f.plan);
      if (t != null) sectorAum += t;
      if (e.name === COMPANY) myAum = t || 0;
    }
    const share = sectorAum ? (myAum / sectorAum) * 100 : null;

    // fee
    const feeRows = state.data.fees[f.feeYear] || [];
    const feeMe = feeRows.find((r) => r.name === COMPANY);
    const feeVal = feeMe ? Calc.feeRate(feeMe, f.plan) : null;

    $("#kpiTotal").textContent = fmtAum(sectorAum);
    $("#kpiMyAum").textContent = fmtAum(myAum);
    $("#kpiMyAumSub").textContent = share != null ? `점유율 ${fmt(share)}%` : "—";
    $("#kpiRet").textContent = me ? fmtPct(me.ret) : "—";
    $("#kpiRetSub").innerHTML = me
      ? `${f.sector} ${me.rank}위 / ${ranked.n} · ${deltaHtml(me.rank, mePrev && mePrev.rank)}`
      : "데이터 없음";
    $("#kpiGap").textContent = me && ranked.avg != null ? fmtPp(me.ret - ranked.avg) : "—";
    $("#kpiFee").textContent = feeVal != null ? fmt(feeVal, 3) + "%" : "—";
    $("#kpiFeeSub").textContent = f.feeYear ? `${f.feeYear}년 · ${f.plan}` : "수수료 연도 없음";

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
          const xlsx = m ? `${m.rank}위 / ${fmt(m.ret)}%` : "—";
          const cell = m
            ? `<span class="rank-main">${m.rank}위 ${dHtml}</span><span class="rank-sub">${fmt(m.ret)}%</span>`
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
    const feeRowsAll = state.data.fees[f.feeYear] || [];

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
      <th>수수료(${f.feeYear || "—"})<br><span class="th-sub">업권순위</span></th>
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
      const aumRankTxt = aumR ? `업권 ${aumR.rank}위/${aumR.n}위` : "업권 —";
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
        const rankTxt = hit ? `업권 ${hit.rank}위/${typeRankMap[ty].n}위` : "업권 —";
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

      const feeRankTxt = feeHit ? `업권 ${feeHit.rank}위/${feeRanked.length}위` : "업권 —";
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
      noteEl.textContent = `${f.sector} 업권 순위 · ${f.plan} · ${f.period}년 · 비교 ${f.cmpQ || "없음"} 대비 ▲▼ · 평균대비 %p · 수수료 낮을수록 상위(${f.feeYear || "—"}년)`;
    }
  }

  function renderSector() {
    const f = state.filters;
    const sectors = ["은행", "증권", "생보", "손보"];
    const indexed = Calc.indexReturns(state.data.returns[f.baseQ] || []);
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
    const prevIndexed = f.cmpQ ? Calc.indexReturns(state.data.returns[f.cmpQ] || []) : null;
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
    const indexed = Calc.indexReturns(state.data.returns[f.baseQ] || []);
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
    const indexed = Calc.indexReturns(state.data.returns[f.baseQ] || []);
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

    const prevIndexed = f.cmpQ ? Calc.indexReturns(state.data.returns[f.cmpQ] || []) : null;
    const sectorRankLabel = f.sector === "전체" ? "전체 순위" : `${f.sector} 순위`;
    const cmpLabel = f.cmpQ
      ? f.cmpQ.replace("Q", "년 ") + "분기"
      : "비교분기 없음";
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
      const rankTxt = m ? `${m.rank}위/${rk.n}` : "—";
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
    const rows = state.data.defaults[f.baseQ] || [];
    const list = Calc.aggregateDefaults(rows, f.risk, f.doPeriod).filter(
      (r) => f.sector === "전체" || r.sector === f.sector
    );
    list.forEach((r, i) => (r.rank = i + 1));

    const risks = ["초저위험", "저위험", "중위험", "고위험"];
    const doPeriodLabel =
      ({ "1m": "1개월", "3m": "3개월", "6m": "6개월", "1y": "1년", "3y": "3년" }[f.doPeriod] ||
        f.doPeriod);

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
      doAvgNote.textContent = `${doPeriodLabel} · 적립금 가중평균 · 회색 = 전체 평균`;
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
      const qLabel = f.baseQ ? f.baseQ.replace("Q", "년 ") + "분기" : "";
      doAumNote.textContent = qLabel
        ? `${qLabel} 기준 · 당사·업권·전체 위험등급 비중(100%)`
        : "당사·업권·전체 위험등급 비중(100%)";
    }

    // 수익률 추이: 당사 · 증권업 · 전체 · 경쟁사 (선택 위험등급·기간)
    const doQs = Calc.sortQuarters(Object.keys(state.data.defaults || {})).slice(-8);
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

    const prevRows = f.cmpQ ? state.data.defaults[f.cmpQ] || [] : [];
    const prevList = Calc.aggregateDefaults(prevRows, f.risk, f.doPeriod).filter(
      (r) => f.sector === "전체" || r.sector === f.sector
    );
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
    const cmpLabel = f.cmpQ
      ? f.cmpQ.replace("Q", "년 ") + "분기"
      : "비교분기 없음";

    const titleEl = $("#doRankTitle");
    if (titleEl) {
      titleEl.innerHTML = `${sectorLabel} 디폴트옵션 순위표 · ${f.risk} <button class="btn" data-export-table="tblDo" data-filename="디폴트순위.xlsx">엑셀</button>`;
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
      `${sortCol.label} 수익률 기준 순위(●) · ${sectorLabel} 평균 ${fmt(sectorAvg)}% · 변동은 ${cmpLabel} 대비 · 누적 수익률(연환산 아님)`;
  }

  function renderFees() {
    const f = state.filters;
    const rows = state.data.fees[f.feeYear] || [];
    const list = Calc.rankFees(rows, f.feePlan, f.feeSector);
    const prevList = f.feeCmpYear
      ? Calc.rankFees(state.data.fees[f.feeCmpYear] || [], f.feePlan, f.feeSector)
      : [];

    const sectors = ["은행", "증권", "생보", "손보"];
    const avgs = sectors.map((s) => {
      const sub = Calc.rankFees(rows, f.feePlan, s);
      return sub.length ? sub.reduce((a, b) => a + b.rate, 0) / sub.length : null;
    });
    makeChart("chartFeeAvg", {
      type: "bar",
      _decimals: 3,
      data: {
        labels: sectors,
        datasets: [{ label: "평균 총비용부담률", data: avgs, backgroundColor: "#4a6fa5" }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });

    // scatter fee vs return
    const indexed = Calc.indexReturns(state.data.returns[f.baseQ] || []);
    const scatterSector = $("#feeScatterScope").value || f.feeSector;
    const points = [];
    for (const fee of Calc.rankFees(rows, f.feePlan, scatterSector === "전체업권" ? "전체" : scatterSector)) {
      const e = indexed.get(fee.name);
      const ret = Calc.metricFor(e, f.feePlan, f.type, f.period).ret;
      if (ret == null) continue;
      points.push({ x: fee.rate, y: ret, name: fee.name });
    }
    makeChart("chartFeeScatter", {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "사업자",
            data: points,
            backgroundColor: points.map((p) =>
              p.name === COMPANY ? "#e85d04" : "rgba(74,111,165,.55)"
            ),
            pointRadius: points.map((p) => (p.name === COMPANY ? 8 : 5)),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          tooltip: {
            callbacks: {
              label(c) {
                return `${c.raw.name}: 수수료 ${fmt(c.raw.x, 3)}%, 수익 ${fmt(c.raw.y)}%`;
              },
            },
          },
          legend: { display: false },
        },
        scales: {
          x: { title: { display: true, text: "수수료 비용부담률 (%) →" } },
          y: { title: { display: true, text: "수익률 (%) ↑" } },
        },
      },
    });

    // 적립금: 수익률 공시(기준분기 또는 최신)의 선택 제도 합계
    const retQs = Calc.sortQuarters(Object.keys(state.data.returns || {}));
    const aumQ =
      (f.baseQ && state.data.returns[f.baseQ] ? f.baseQ : null) ||
      (retQs.length ? retQs[retQs.length - 1] : null);
    const aumIndexed = Calc.indexReturns(state.data.returns[aumQ] || []);

    let feeAvg = null;
    if (list.length) {
      feeAvg = list.reduce((a, b) => a + b.rate, 0) / list.length;
    }
    const prevRankMap = new Map(prevList.map((x) => [x.name, x.rank]));
    const sectorLabel = f.feeSector === "전체" ? "전체" : f.feeSector;
    const cmpLabel = f.feeCmpYear ? `${f.feeCmpYear}년` : "비교연도 없음";
    const aumColLabel = `${f.feePlan} 적립금(억원)`;

    const feeTitle = $("#feeRankTitle");
    if (feeTitle) {
      feeTitle.innerHTML = `${sectorLabel} 수수료 순위표 · ${f.feeYear || "—"} · ${f.feePlan} <button class="btn" data-export-table="tblFee" data-filename="수수료순위.xlsx">엑셀</button>`;
    }
    const feeNote = $("#feeNote");
    if (feeNote) {
      feeNote.textContent = `수수료 낮을수록 1위 · ${sectorLabel} 평균 ${fmt(feeAvg, 2)}% · 변동은 ${cmpLabel} 대비 · 적립금은 ${
        aumQ ? aumQ.replace("Q", "년 ") + "분기" : "—"
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
    $("#dataMeta").textContent = `최종 갱신: ${state.data.meta.updatedAt || "—"} · 수익률 ${Object.keys(state.data.returns).length}분기 · 디폴트 ${Object.keys(state.data.defaults).length}분기 · 수수료 ${Object.keys(state.data.fees).length}년`;
  }

  let pendingUploads = [];

  function showValidateModal(parsedList) {
    pendingUploads = parsedList;
    const lines = parsedList.map((p) => {
      const kindLabel =
        p.kind === "returns" ? "수익률" : p.kind === "defaults" ? "디폴트옵션" : "수수료";
      return `· ${p.fileName} → ${kindLabel} ${p.key || "(키 없음)"} · 인식 ${p.rows.length}행 · 문제 ${p.problems.length}건 · 스킵 ${p.skipped || 0}`;
    });
    const hardIssues = parsedList.flatMap((p) =>
      (p.issues || []).map((msg) => `${p.fileName}: ${msg}`)
    );
    $("#validateSummary").innerHTML =
      `<strong>검증 결과</strong><br>${lines.join("<br>")}` +
      (hardIssues.length
        ? `<br><span style="color:#c62828">${hardIssues.join("<br>")}</span>`
        : "");

    const allProblems = parsedList.flatMap((p) =>
      (p.problems || []).map((pr) => ({ ...pr, file: p.fileName }))
    );
    if (!allProblems.length) {
      $("#validateProblems").innerHTML =
        '<p class="note" style="margin:0">문제 행 없음. 저장해도 됩니다.</p>';
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

    const canSave =
      parsedList.every((p) => p.key && p.rows.length) && hardIssues.length === 0;
    $("#validateSave").disabled = !canSave;
    $("#validateSave").textContent = canSave
      ? allProblems.length
        ? `문제 ${allProblems.length}건 있으나 인식 행만 저장`
        : "검증 통과 · 저장"
      : "저장 불가 (키·인식 행 확인)";
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
    for (const file of files) {
      const parsed = await Parser.parseFile(file, { kind, key });
      // 사용자가 키를 입력했으면 우선
      if (key) parsed.key = key;
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

  /** 캔버스를 페이지 높이만큼 잘라 넣어 잘림 방지 (PNG로 선명도 유지) */
  function addCanvasPaginated(pdf, canvas, margin) {
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const pdfImgW = pageWidth - margin * 2;
    const pxPerMm = canvas.width / pdfImgW;
    let srcY = 0;
    let pageIdx = 0;

    while (srcY < canvas.height - 1) {
      const usableMm = pageHeight - margin * 2;
      const slicePx = Math.max(1, Math.min(canvas.height - srcY, Math.floor(usableMm * pxPerMm)));

      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = slicePx;
      const sctx = slice.getContext("2d");
      sctx.fillStyle = "#ffffff";
      sctx.fillRect(0, 0, slice.width, slice.height);
      sctx.drawImage(canvas, 0, srcY, canvas.width, slicePx, 0, 0, canvas.width, slicePx);

      const sliceHmm = slicePx / pxPerMm;
      if (pageIdx > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, pdfImgW, sliceHmm);

      srcY += slicePx;
      pageIdx++;
      if (pageIdx > 40) break;
    }
  }

  /** jsPDF 기본 폰트는 한글 미지원 → 캔버스에 시스템 한글 폰트로 제목 그림 */
  function drawPdfTitleBanner(widthPx, title, subtitle) {
    const scale = 2;
    const h = Math.round(56 * scale);
    const c = document.createElement("canvas");
    c.width = widthPx;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0f2744";
    ctx.fillRect(0, 0, widthPx, h);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${22 * scale}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    ctx.fillText(title, 16 * scale, h * 0.42);
    if (subtitle) {
      ctx.font = `${14 * scale}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillText(subtitle, 16 * scale, h * 0.72);
    }
    return c;
  }

  async function captureElement(el, bg) {
    const w = Math.ceil(Math.max(el.scrollWidth, el.offsetWidth, el.clientWidth));
    const h = Math.ceil(Math.max(el.scrollHeight, el.offsetHeight, el.clientHeight));
    return html2canvas(el, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: bg,
      logging: false,
      scrollX: 0,
      scrollY: 0,
      width: w,
      height: h,
      windowWidth: w,
      windowHeight: h,
      x: 0,
      y: 0,
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
    toast("PDF 생성 중… 잠시만 기다려 주세요.");

    const prevScrollX = window.scrollX;
    const prevScrollY = window.scrollY;
    window.scrollTo(0, 0);
    document.body.classList.add("capturing-pdf");

    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));

      const cFilter = await captureElement(filterEl, "#ffffff");
      const cPage = await captureElement(pageEl, "#f4f6f8");

      const q = state.filters.baseQ || state.filters.feeYear || "";
      const pageLabel = PAGE_LABELS[state.page] || state.page;
      const titleMain = "한화투자증권 퇴직연금 공시 비교";
      const titleSub = `${pageLabel}${q ? " · " + q : ""}`;

      const gap = 20;
      const width = Math.max(cFilter.width, cPage.width);
      const cTitle = drawPdfTitleBanner(width, titleMain, titleSub);

      const combined = document.createElement("canvas");
      combined.width = width;
      combined.height = cTitle.height + gap + cFilter.height + gap + cPage.height;
      const ctx = combined.getContext("2d");
      ctx.fillStyle = "#f4f6f8";
      ctx.fillRect(0, 0, combined.width, combined.height);
      let y = 0;
      ctx.drawImage(cTitle, 0, y);
      y += cTitle.height + gap;
      ctx.drawImage(cFilter, 0, y);
      y += cFilter.height + gap;
      ctx.drawImage(cPage, 0, y);

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      // 한글은 pdf.text 사용하지 않음 (깨짐 방지). 제목은 위 배너 이미지에 포함.
      addCanvasPaginated(pdf, combined, 6);
      const fname = `퇴직연금_${pageLabel}_${q || "report"}.pdf`;
      pdf.save(fname);
      toast("PDF를 저장했습니다.");
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
    if (state.page !== "data") renderCompetitors();
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
      if (!confirm("이 PC의 로컬 저장 데이터를 지우고 배포본으로 되돌릴까요?")) return;
      localStorage.removeItem(LS_DATA);
      loadData();
      syncFilterControls();
      renderPage();
      toast("배포본 데이터로 복원했습니다.");
    });

    // export buttons via delegation
    document.body.addEventListener("click", (e) => {
      const t = e.target.closest("[data-export-chart]");
      if (t) exportChartPng(t.dataset.exportChart, t.dataset.filename);
      const x = e.target.closest("[data-export-table]");
      if (x) exportTableXlsx(x.dataset.exportTable, x.dataset.filename);
    });

    $("#feeScatterScope")?.addEventListener("change", () => renderFees());
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
