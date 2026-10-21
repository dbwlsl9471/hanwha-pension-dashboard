/* 포털 원본 엑셀(SheetJS) 파서 */
(function (global) {
  const SKIP = new Set(["합계", "자사계열사", "기타 사업자"]);
  const TYPE_MAP = {
    "예금성 원리금보장": "예금성",
    "시장성 원리금보장": "시장성",
    "원리금비보장": "실적배당형",
    "원리금 비보장": "실적배당형",
    "원리금 보장": "원리금보장",
    "원리금보장": "원리금보장",
  };

  function sectorOf(name) {
    const n = String(name).replace(/\s/g, "");
    if (n.includes("은행") || n.endsWith("뱅크") || n.includes("iM뱅크")) return "은행";
    if (n.includes("증권")) return "증권";
    if (n.includes("생명") || n.includes("라이프") || n.includes("연금보험")) return "생보";
    if (n.includes("손해") || n.includes("화재") || n.includes("해상")) return "손보";
    return "기타";
  }

  function toNum(v) {
    if (v == null || v === "" || v === "-") return null;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
    if (!s || s === "-") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function sheetToMatrix(wb) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  }

  function detectKind(matrix) {
    const head =
      (matrix[0] && matrix[0][0] ? String(matrix[0][0]) : "") +
      (matrix[6] && matrix[6][0] ? String(matrix[6][0]) : "");
    if (head.includes("디폴트") || head.includes("사전지정")) return "defaults";
    if (
      head.includes("비용") ||
      head.includes("수수료") ||
      (matrix[6] && String(matrix[6][0] || "").includes("사업자"))
    ) {
      if (matrix[7] && String(matrix[7][1] || "").includes("운용관리")) return "fees";
    }
    if (
      head.includes("적립금") ||
      head.includes("운용수익률") ||
      (matrix[6] && String(matrix[6][0]) === "사업자명")
    )
      return "returns";
    if (matrix[7] && String(matrix[7][1] || "").includes("운용관리")) return "fees";
    if (matrix[6] && String(matrix[6][0] || "").includes("상품명")) return "defaults";
    return "returns";
  }

  function blockEmpty(b) {
    return !b || (b.aum == null && b.r1 == null && b.r3 == null && b.r5 == null && b.r7 == null && b.r10 == null);
  }

  function parseReturns(matrix, quarterKey) {
    let key = quarterKey;
    if (!key) {
      const y = toNum(matrix[2] && matrix[2][1]);
      const q = toNum(matrix[2] && matrix[2][3]);
      if (y && q) key = `${y}Q${q}`;
    }
    const rows = [];
    const problems = [];
    let skipped = 0;
    let cur = null;
    let scanned = 0;
    for (let r = 9; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      if (row[0]) cur = String(row[0]).trim();
      const typRaw = row[1] != null ? String(row[1]).trim() : "";
      if (!typRaw && !row[0]) continue;
      scanned++;
      if (!typRaw) {
        problems.push({ row: excelRow, name: cur || "", reason: "유형(원리금구분) 없음" });
        continue;
      }
      if (SKIP.has(typRaw)) {
        skipped++;
        continue;
      }
      if (!cur) {
        problems.push({ row: excelRow, name: "", reason: "사업자명 없음", detail: typRaw });
        continue;
      }
      const typ = TYPE_MAP[typRaw];
      if (!typ) {
        problems.push({
          row: excelRow,
          name: cur,
          reason: "알 수 없는 유형",
          detail: typRaw,
        });
        continue;
      }
      const block = (c0) => ({
        aum: toNum(row[c0]),
        r1: toNum(row[c0 + 1]),
        r3: toNum(row[c0 + 2]),
        r5: toNum(row[c0 + 3]),
        r7: toNum(row[c0 + 4]),
        r10: toNum(row[c0 + 5]),
      });
      const DB = block(2);
      const DC = block(8);
      const IRP = block(14);
      if (blockEmpty(DB) && blockEmpty(DC) && blockEmpty(IRP)) {
        problems.push({
          row: excelRow,
          name: cur,
          reason: "적립금·수익률 수치 없음",
          detail: typ,
        });
        continue;
      }
      rows.push({ name: cur, sector: sectorOf(cur), type: typ, DB, DC, IRP });
    }
    const issues = [];
    if (!key) issues.push("분기(연도/분기)를 파일에서 읽지 못했습니다. 분기/연도를 직접 입력하세요.");
    if (!rows.length) issues.push("인식된 수익률 행이 없습니다.");
    return { key, rows, problems, skipped, scanned, issues };
  }

  function parseDefaults(matrix, quarterKey) {
    const rows = [];
    const problems = [];
    let skipped = 0;
    let scanned = 0;
    for (let r = 8; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      const product = row[0] != null ? String(row[0]).trim() : "";
      const name = row[1] != null ? String(row[1]).trim() : "";
      const risk = row[4] != null ? String(row[4]).trim() : "";
      if (!product && !name && !risk) continue;
      scanned++;
      if (!name) {
        problems.push({ row: excelRow, name: "", reason: "사업자명 없음", detail: product });
        continue;
      }
      if (!risk) {
        problems.push({ row: excelRow, name, reason: "위험등급 없음", detail: product });
        continue;
      }
      const aum = toNum(row[7]);
      const r1y = toNum(row[11]);
      if (aum == null && r1y == null && toNum(row[8]) == null) {
        // still accept — many rows have "-" aum but rates
      }
      rows.push({
        name,
        sector: sectorOf(name),
        product,
        risk,
        aum_dc: toNum(row[5]),
        aum_irp: toNum(row[6]),
        aum: toNum(row[7]),
        r1m: toNum(row[8]),
        r3m: toNum(row[9]),
        r6m: toNum(row[10]),
        r1y: toNum(row[11]),
        r3y: toNum(row[12]),
      });
    }
    const issues = [];
    if (!quarterKey) issues.push("디폴트옵션은 분기/연도(예: 2026Q2)를 입력해 주세요.");
    if (!rows.length) issues.push("인식된 디폴트옵션 행이 없습니다.");
    return { key: quarterKey, rows, problems, skipped, scanned, issues };
  }

  function parseFees(matrix, yearKey) {
    let key = yearKey;
    if (!key) {
      const y = toNum(matrix[2] && matrix[2][1]);
      if (y) key = String(Math.trunc(y));
    }
    const rows = [];
    const problems = [];
    let skipped = 0;
    let scanned = 0;
    for (let r = 9; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      const name = row[0] != null ? String(row[0]).trim() : "";
      if (!name) {
        if (row.some((c) => c != null && String(c).trim() !== "")) {
          scanned++;
          problems.push({ row: excelRow, name: "", reason: "사업자명 없음" });
        }
        continue;
      }
      scanned++;
      const plan = (c0) => {
        const face = toNum(row[c0 + 4]);
        const online = toNum(row[c0 + 5]);
        return {
          face,
          online,
          rate: face != null ? face : online,
          metric: "수수료 비용부담률",
        };
      };
      const DB = plan(1);
      const DC = plan(7);
      const IRP = plan(13);
      if (DB.rate == null && DC.rate == null && IRP.rate == null) {
        problems.push({ row: excelRow, name, reason: "수수료율 수치 없음" });
        continue;
      }
      rows.push({ name, sector: sectorOf(name), DB, DC, IRP });
    }
    const issues = [];
    if (!key) issues.push("연도를 파일에서 읽지 못했습니다. 연도를 직접 입력하세요.");
    if (!rows.length) issues.push("인식된 수수료 행이 없습니다.");
    return { key, rows, problems, skipped, scanned, issues };
  }

  async function parseFile(file, opts = {}) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const matrix = sheetToMatrix(wb);
    const kind = opts.kind || detectKind(matrix);
    let result;
    if (kind === "defaults") result = parseDefaults(matrix, opts.key);
    else if (kind === "fees") result = parseFees(matrix, opts.key);
    else result = parseReturns(matrix, opts.key);
    return {
      kind,
      key: result.key,
      rows: result.rows,
      problems: result.problems || [],
      skipped: result.skipped || 0,
      scanned: result.scanned || 0,
      issues: result.issues || [],
      fileName: file.name,
      previewRows: result.rows.length,
    };
  }

  global.Parser = { parseFile, detectKind, sectorOf, toNum };
})(window);
