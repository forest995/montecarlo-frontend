import {
  simulate,
  commentaryRun,
  exportExcel,
  getConfidenceFactors,
  exportJson
} from "./api";

import { useEffect, useMemo, useRef, useState } from "react";


const DRIVER_OPTIONS = [
  "Market & economic conditions",
  "Labour market & productivity",
  "Site & environmental conditions",
  "Regulatory environments",
  "Procurement & contract complexities",
  "Technology & commissioning complexity",
];

const DRIVER_TOOLTIPS = {
  "Market & economic conditions":
    "Changes in market prices and economic conditions that affect multiple cost items at the same time (e.g. materials escalation, inflation, fuel or energy costs). Use this when costs tend to rise or fall together due to broader market forces.",
  "Labour market & productivity":
    "Availability, cost, and productivity of labour that can influence multiple work packages simultaneously (e.g. wage pressure, labour shortages, industrial action, productivity variation).",
  "Site & environmental conditions":
    "Physical site conditions or environmental factors that can impact several cost items together (e.g. ground conditions, access constraints, utilities, weather).",
  "Regulatory environments":
    "Regulatory, approval, or authority requirements that may constrain delivery and affect multiple cost items at once (e.g. permits, possessions, third-party approvals, compliance conditions).",
  "Procurement & contract complexities":
    "Commercial and procurement factors that can influence costs across multiple packages (e.g. tender market behaviour, contract packaging, risk allocation, claims environment).",
  "Technology & commissioning complexity":
    "Complexity or uncertainty associated with systems, technology, testing, or commissioning that may affect multiple cost items together (e.g. system integration or unproven technology).",
};

const SENSITIVITY_LEVELS = ["none", "low", "medium", "high"];

function sensitivityToIndex(s) {
  const i = SENSITIVITY_LEVELS.indexOf(String(s || "").toLowerCase());
  return i === -1 ? 2 : i; // default = medium
}

function indexToSensitivity(i) {
  const idx = Math.min(3, Math.max(0, Number(i) || 0));
  return SENSITIVITY_LEVELS[idx];
}


const EXCLUDED_FACTORS = new Set(["% Allocation"]);

function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function safeFilename(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// cbs01, cbs02 ... / r01, r02 ...
function makeSequentialId(prefix, n) {
  const s = String(n).padStart(2, "0");
  return `${prefix}${s}`;
}

async function fetchJsonOrThrow(res) {
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail
      : [{ msg: "Request failed", detail: data || text }];
    const err = new Error("API error");
    err.detail = detail;
    throw err;
  }
  return data;
}

/**
 * Minimal CSV parsing helpers
 * - Splits by newlines then commas
 * - Strips surrounding quotes
 * - Good enough for MVP (no embedded commas inside quotes)
 */
function normaliseLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function splitRow(row) {
  return row
    .split(",")
    .map((c) => c.trim())
    .map((c) => c.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

/**
 * CBS CSV: names only
 * Supports:
 *  - Header: name
 *  - Single column without header
 *  - One name per line
 */
/**
 * CBS CSV: supports names only OR name + baseCost
 * Supports:
 *  - Header: name, baseCost (preferred)
 *  - Header aliases: cost, base_cost, base (for baseCost)
 *  - Single column without header (names only)
 *  - One name per line
 *
 * Returns: [{ name: string, baseCost: number|null }]
 */
function parseCbsCsv(csvText) {
  const lines = normaliseLines(csvText);
  if (lines.length === 0) return [];

  const header = splitRow(lines[0]).map((h) => h.toLowerCase());

  const findIdx = (aliases) => {
    for (const a of aliases) {
      const i = header.indexOf(a.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  const nameIdx = findIdx(["name", "cbs", "cbsname"]);
  const baseIdx = findIdx(["basecost", "base_cost", "cost", "base"]);

  const out = [];
  const seen = new Set();

  const toNumOrNull = (v) => {
    const n = Number(String(v ?? "").trim());
    return Number.isFinite(n) ? n : null;
  };

  // Case A: Has header row with a name column
  if (nameIdx !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const cells = splitRow(lines[i]);
      const name = (cells[nameIdx] || "").trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const baseCost = baseIdx !== -1 ? toNumOrNull(cells[baseIdx]) : null;
      out.push({ name, baseCost });
    }
    return out;
  }

  // Case B: No header row => treat as names-only (first col)
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const name = (cells[0] || "").trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, baseCost: null });
  }

  return out;
 
}

/**
 * Risks CSV: full fields (+ optional riskType)
 * Expected headers (aliases supported):
 *  name/risk, riskType/type, probability/p, low/lowCost, mostLikely/mostLikelyCost/mode, high/highCost
 */
function parseRisksCsv(csvText) {
  const lines = normaliseLines(csvText);
  if (lines.length === 0) return { risks: [], warnings: ["No rows found."] };

  const headerCells = splitRow(lines[0]).map((h) => h.toLowerCase());

  const idx = (aliases) => {
    for (const a of aliases) {
      const i = headerCells.indexOf(a.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  const nameIdx = idx(["name", "risk"]);
  const typeIdx = idx(["risktype", "type"]);
  const pIdx = idx(["probability", "p"]);
  const lowIdx = idx(["lowcost", "low"]);
  const mlIdx = idx(["mostlikelycost", "mostlikely", "mode"]);
  const highIdx = idx(["highcost", "high"]);

  const missing = [];
  if (nameIdx === -1) missing.push("name (or risk)");
  if (pIdx === -1) missing.push("probability (or p)");
  if (lowIdx === -1) missing.push("lowCost (or low)");
  if (mlIdx === -1) missing.push("mostLikelyCost (or mostLikely/mode)");
  if (highIdx === -1) missing.push("highCost (or high)");

  if (missing.length) {
    return {
      risks: [],
      warnings: [`Missing required headers: ${missing.join(", ")}`],
    };
  }

  const warnings = [];
  const parsed = [];

  for (let rowNum = 1; rowNum < lines.length; rowNum++) {
    const cells = splitRow(lines[rowNum]);

    const name = (cells[nameIdx] || "").trim();
    if (!name) {
      warnings.push(`Row ${rowNum + 1}: missing risk name; skipped.`);
      continue;
    }

    const toNum = (v) => {
      const n = Number(String(v || "").trim());
      return Number.isFinite(n) ? n : NaN;
    };

    let riskType = "contingent";
    if (typeIdx !== -1) {
      const raw = String(cells[typeIdx] || "").trim().toLowerCase();
      if (raw === "inherent" || raw === "contingent") {
        riskType = raw;
      } else if (raw) {
        warnings.push(`Row ${rowNum + 1}: invalid riskType '${raw}', defaulted to 'contingent'.`);
      }
    }

    let probability = toNum(cells[pIdx]);
    let lowCost = toNum(cells[lowIdx]);
    let mostLikelyCost = toNum(cells[mlIdx]);
    let highCost = toNum(cells[highIdx]);

    if (!Number.isFinite(probability)) {
      warnings.push(`Row ${rowNum + 1}: probability not a number; set to 0.`);
      probability = 0;
    }
    if (probability < 0 || probability > 1) {
      warnings.push(`Row ${rowNum + 1}: probability out of range; clamped to 0–1.`);
      probability = Math.min(1, Math.max(0, probability));
    }

    const fixCost = (val, label) => {
      if (!Number.isFinite(val)) {
        warnings.push(`Row ${rowNum + 1}: ${label} not a number; set to 0.`);
        return 0;
      }
      if (val < 0) {
        warnings.push(`Row ${rowNum + 1}: ${label} < 0; set to 0.`);
        return 0;
      }
      return val;
    };

    lowCost = fixCost(lowCost, "lowCost");
    mostLikelyCost = fixCost(mostLikelyCost, "mostLikelyCost");
    highCost = fixCost(highCost, "highCost");

    if (riskType === "inherent") {
      // Costs are ignored by your backend logic; keep UI consistent:
      lowCost = 0;
      mostLikelyCost = 0;
      highCost = 0;
    } else {
      // Optional sanity: warn only
      if (!(lowCost <= mostLikelyCost && mostLikelyCost <= highCost)) {
        warnings.push(
          `Row ${rowNum + 1}: expected low <= mostLikely <= high (got ${lowCost}, ${mostLikelyCost}, ${highCost}). Simulation will still run.`
        );
      }
    }

    parsed.push({ name, riskType, probability, lowCost, mostLikelyCost, highCost });
  }

  return { risks: parsed, warnings };
}

function App() {
  const DOMINANT_MIN = 0.30;
  const MODERATE_MIN = 0.15;
  const MAX_PER_GROUP = 6;
  const [status, setStatus] = useState("Loading…");
  const [confidenceFactors, setConfidenceFactors] = useState([]);
  const [confidenceFactorMap, setConfidenceFactorMap] = useState({});
  const [errors, setErrors] = useState([]);

  // Counters so new rows get nice IDs
  const cbsCounterRef = useRef(4); // start with 4 CBS items
  const riskCounterRef = useRef(2); // start with 2 risks

  // Default CBS starter headers
  const [cbsItems, setCbsItems] = useState([
    {
      id: "cbs01",
      name: "INVESTIGATION",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs02",
      name: "FUNCTIONAL DESIGN",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs03",
      name: "DETAILED DESIGN",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs04",
      name: "CONSTRUCTION",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
  ]);

  // Risk Register
  const [risks, setRisks] = useState([
    {
      id: "r01",
      name: "Unknown services relocation",
      riskType: "contingent",
      probability: 0.2,
      lowCost: 200000,
      mostLikelyCost: 600000,
      highCost: 1200000,
    },
    {
      id: "r02",
      name: "Contamination disposal",
      riskType: "contingent",
      probability: 0.1,
      lowCost: 150000,
      mostLikelyCost: 400000,
      highCost: 900000,
    },
  ]);

  // Settings
  const [iterations, setIterations] = useState(5000);
  const [seed, setSeed] = useState(123456);


  // Correlation modelling (None | Standard)
  const [correlationMode, setCorrelationMode] = useState("none");

  // Results
  const [results, setResults] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [sensitivity, setSensitivity] = useState([]);

  // Commentary (AI)
  const [commentary, setCommentary] = useState(null);
  const [commentaryMode, setCommentaryMode] = useState(null);
  const [isCommentaryRunning, setIsCommentaryRunning] = useState(false);
  const [commentaryError, setCommentaryError] = useState(null);

  const resetResults = () => {
    setResults(null);
    setSensitivity([]);

    // reset commentary as well
    setCommentary(null);
    setCommentaryMode(null);
    setIsCommentaryRunning(false);
    setCommentaryError(null);
  };

  // File inputs
  const cbsFileInputRef = useRef(null);
  const risksFileInputRef = useRef(null);

  useEffect(() => {
  getConfidenceFactors()
    .then((data) => {
      const factors = data.factors || {};
      const keysRaw = Object.keys(factors);
      const keys = keysRaw.filter((k) => !EXCLUDED_FACTORS.has(k));
      setConfidenceFactors(keys);
      setConfidenceFactorMap(factors);
      setStatus("Ready ✔");
    })
    .catch((err) => {
      console.error(err);
      setStatus("Backend NOT reachable ✖");
    });
}, []);

  const confidenceSet = useMemo(() => new Set(confidenceFactors), [confidenceFactors]);

  // Ensure CBS confidenceFactor stays valid after config loads
  useEffect(() => {
    if (confidenceFactors.length === 0) return;

    const fallback = confidenceFactors.includes("Realistic") ? "Realistic" : confidenceFactors[0];

    setCbsItems((prev) =>
      prev.map((x) => {
        if (EXCLUDED_FACTORS.has(x.confidenceFactor)) return { ...x, confidenceFactor: fallback };
        if (x.confidenceFactor && !confidenceSet.has(x.confidenceFactor)) return { ...x, confidenceFactor: fallback };
        return x;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confidenceFactors]);

  const totalBase = useMemo(() => {
    return cbsItems.reduce((sum, r) => sum + (Number(r.baseCost) || 0), 0);
  }, [cbsItems]);

  function isUserDefinedFactor(cf) {
    return String(cf || "").trim().toLowerCase() === "user defined";
  }

  function calcDerivedCosts(row) {
    // If User defined: take explicit fields
    if (isUserDefinedFactor(row.confidenceFactor)) {
      return {
        best: Number(row.bestCaseCost),
        ml: Number(row.mostLikelyCost),
        worst: Number(row.worstCaseCost),
        isDerived: false,
      };
    }

    const f = confidenceFactorMap[row.confidenceFactor];
    const base = Number(row.baseCost) || 0;
    if (!f) {
      return { best: NaN, ml: NaN, worst: NaN, isDerived: true };
    }

    const best = base * Number(f.best ?? 1);
    const ml = base * Number(f.most_likely ?? 1);
    const worst = base * Number(f.worst ?? 1);
    return { best, ml, worst, isDerived: true };
  }

  function addCbsRow() {
    const defaultFactor = confidenceFactors.includes("Realistic")
      ? "Realistic"
      : confidenceFactors[0] || "Realistic";

    cbsCounterRef.current += 1;
    const newId = makeSequentialId("cbs", cbsCounterRef.current);

    setCbsItems((prev) => [
      ...prev,
      {
        id: newId,
        name: "",
        baseCost: 0,
        confidenceFactor: defaultFactor,
        bestCaseCost: null,
        mostLikelyCost: null,
        worstCaseCost: null,
      driverGroup: "",
        sensitivity: "medium",
      },
    ]);

    resetResults();
  }

  function deleteCbsRow(id) {
    setCbsItems((prev) => prev.filter((x) => x.id !== id));
    resetResults();
  }

  function updateCbsRow(id, patch) {
    setCbsItems((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };

        // If switching to non-user-defined, clear manual fields (avoid stale data)
        if ("confidenceFactor" in patch && !isUserDefinedFactor(next.confidenceFactor)) {
          next.bestCaseCost = null;
          next.mostLikelyCost = null;
          next.worstCaseCost = null;
        }

        return next;
      })
    );
    resetResults();
  }

  function addRiskRow() {
    riskCounterRef.current += 1;
    const newId = makeSequentialId("r", riskCounterRef.current);

    setRisks((prev) => [
      ...prev,
      {
        id: newId,
        name: "",
        riskType: "contingent",
        probability: 0,
        lowCost: 0,
        mostLikelyCost: 0,
        highCost: 0,
      },
    ]);

    resetResults();
  }

  function deleteRiskRow(id) {
    setRisks((prev) => prev.filter((x) => x.id !== id));
    resetResults();
  }

  function updateRiskRow(id, patch) {
    setRisks((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };

        // If riskType switched to inherent => zero out costs in UI
        if ("riskType" in patch && String(patch.riskType).toLowerCase() === "inherent") {
          next.lowCost = 0;
          next.mostLikelyCost = 0;
          next.highCost = 0;
        }

        return next;
      })
    );
    resetResults();
  }

  function buildPayload() {
    return {
      settings: {
        iterations: Number(iterations),
        seed: Number(seed),
        percentiles: [0.05, 0.1, 0.5, 0.9],
      },
      confidenceTableVersion: "v1",
      correlation_mode: correlationMode,
      cbsItems: cbsItems.map((x) => ({
        id: x.id,
        name: x.name,
        baseCost: Number(x.baseCost) || 0,
        confidenceFactor: x.confidenceFactor,
        driver_group: correlationMode === "standard" ? (x.driverGroup || null) : null,
        sensitivity: correlationMode === "standard" ? (x.sensitivity || "medium") : null,
        // backend uses these only when confidenceFactor == "User defined"
        bestCaseCost:
          x.bestCaseCost === null || x.bestCaseCost === undefined || x.bestCaseCost === ""
            ? null
            : Number(x.bestCaseCost),
        mostLikelyCost:
          x.mostLikelyCost === null || x.mostLikelyCost === undefined || x.mostLikelyCost === ""
            ? null
            : Number(x.mostLikelyCost),
        worstCaseCost:
          x.worstCaseCost === null || x.worstCaseCost === undefined || x.worstCaseCost === ""
            ? null
            : Number(x.worstCaseCost),
      })),
      contingentRisks: risks.map((r) => ({
        id: r.id,
        name: r.name,
        riskType: r.riskType || "contingent",
        probability: Number(r.probability) || 0,
        lowCost: Number(r.lowCost) || 0,
        mostLikelyCost: Number(r.mostLikelyCost) || 0,
        highCost: Number(r.highCost) || 0,
      })),
    };
  }

  async function runSimulation() {
    setErrors([]);
    resetResults();
   setIsRunning(true);

    const payload = buildPayload();

    try {
      const data = await simulate(payload);
      setResults(data.results || null);
      setSensitivity(Array.isArray(data.sensitivity) ? data.sensitivity : []);
      runCommentary(payload);
    }   catch (e) {
    console.error(e);
    setErrors(e.detail || [{ msg: "Network/API error", detail: String(e) }]);
    }  finally {
    setIsRunning(false);
    }
  }

  async function runCommentary(payloadObj) {
  setIsCommentaryRunning(true);
  setCommentaryError(null);
  setCommentary(null);
  setCommentaryMode(null);

  const payload = payloadObj ?? buildPayload();

  try {
    const data = await commentaryRun(payload);
    setCommentaryMode(data.mode_used || null);
    setCommentary(data.commentary || "");
    } catch (err) {
    console.error(err);
    setCommentaryError(String(err?.message || err));
    } finally {
    setIsCommentaryRunning(false);
    }
  }


  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  
  async function downloadJson() {
  if (!results) return;

  setErrors([]);
  setIsExporting(true);

  const payload = buildPayload();

  try {
    const blob = await exportJson(payload);
    if (!blob) return;

    const filename = `cost-risk-${safeFilename("scenario") || "scenario"}.json`;
    triggerDownload(blob, filename);
  } catch (err) {
    setErrors([err.message || "Failed to export JSON"]);
  } finally {
    setIsExporting(false);
  }
}


  async function downloadExcel() {
  if (!results) return;

  setErrors([]);
  setIsExporting(true);

  const payload = buildPayload();

  try {
    const blob = await exportExcel(payload);
    if (!blob) return;

    const filename = `cost-risk-results.xlsx`;
    triggerDownload(blob, filename);
  } catch (err) {
    setErrors([err.message || "Export Excel failed"]);
  } finally {
    setIsExporting(false);
  }
}



  // ---- CSV IMPORTS ----
  function openCbsCsvPicker() {
    setErrors([]);
    cbsFileInputRef.current?.click();
  }

  async function onCbsCsvSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCbsCsv(text);

      if (rows.length === 0) {
        setErrors([{ msg: "CBS import failed", detail: "No CBS names found in CSV." }]);
        return;
      }

      const defaultFactor = confidenceFactors.includes("Realistic")
        ? "Realistic"
        : confidenceFactors[0] || "Realistic";

      const newItems = rows.map((row, idx) => ({
         id: makeSequentialId("cbs", idx + 1),
        name: row.name,
        baseCost: row.baseCost ?? 0,
        confidenceFactor: defaultFactor, // default = Realistic (or first available)
        bestCaseCost: null,
        mostLikelyCost: null,
        worstCaseCost: null,
      driverGroup: "",
        sensitivity: "medium",
      }));

      setCbsItems(newItems);
      cbsCounterRef.current = newItems.length;
      resetResults();
    } catch (err) {
      console.error(err);
      setErrors([{ msg: "CBS import failed", detail: String(err) }]);
    }
  }

  function openRisksCsvPicker() {
    setErrors([]);
    risksFileInputRef.current?.click();
  }

  async function onRisksCsvSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const { risks: parsed, warnings } = parseRisksCsv(text);

      if (parsed.length === 0) {
        setErrors([{ msg: "Risk import failed", detail: warnings.join("\n") || "No risks parsed." }]);
        return;
      }

      const newRisks = parsed.map((r, idx) => ({
        id: makeSequentialId("r", idx + 1),
        name: r.name,
        riskType: r.riskType || "contingent",
        probability: r.probability,
        lowCost: r.lowCost,
        mostLikelyCost: r.mostLikelyCost,
        highCost: r.highCost,
      }));

      setRisks(newRisks);
      riskCounterRef.current = newRisks.length;
      resetResults();

      if (warnings.length) {
        setErrors([{ msg: "Risk import warnings (import succeeded)", detail: warnings.join("\n") }]);
      }
    } catch (err) {
      console.error(err);
      setErrors([{ msg: "Risk import failed", detail: String(err) }]);
    }
  }

  const canExport = !!results && !isRunning && !isExporting;

  const groupedSensitivity = useMemo(() => {
    const rows = Array.isArray(sensitivity) ? sensitivity : [];

    const sorted = [...rows].sort((a, b) => (Number(b.abs_rho) || 0) - (Number(a.abs_rho) || 0));
    const dominant = sorted
      .filter((x) => (Number(x.abs_rho) || 0) >= DOMINANT_MIN)
      .slice(0, MAX_PER_GROUP);

    const moderate = sorted
      .filter((x) => {
        const v = Number(x.abs_rho) || 0;
        return v >= MODERATE_MIN && v < DOMINANT_MIN;
      })
      .slice(0, MAX_PER_GROUP);

    return { dominant, moderate };
  }, [sensitivity]);

  return (
    <div style={{ padding: 24, fontFamily: "Arial, sans-serif", maxWidth: 1250, margin: "0 auto" }}>
      <style>{`
        .btn { padding: 8px 12px; cursor: pointer; border-radius: 8px; border: 1px solid #999; background: #f7f7f7; color: #111; font-weight: 600; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn:hover:not(:disabled) { background: #ededed; }
        .iconBtn { padding: 6px 10px; cursor: pointer; border-radius: 8px; border: 1px solid #999; background: #f7f7f7; color: #111; font-weight: 800; line-height: 1; min-width: 40px; text-align: center; }
        .iconBtn:hover { background: #ededed; }
        .dangerBtn { border-color: #c33; background: #fff5f5; }
        .dangerBtn:hover { background: #ffecec; }
        .text-primary { color: #eaeaea; }
        .text-secondary { color: #bdbdbd; }
        .text-muted { color: #9aa0a6; }
        code { background: rgba(0,0,0,0.08); padding: 2px 6px; border-radius: 6px; }
        .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid #999; background:#f3f3f3; }
      `}</style>

      <h1 style={{ marginBottom: 6 }} className="text-primary">Risk Adjusted Project Cost Estimator MVP</h1>

      <div style={{ marginBottom: 18 }} className="text-secondary">
        Status: <strong className="text-primary">{status}</strong>
      </div>

      {/* CBS */}
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }} className="text-primary">Cost Breakdown Structure</h2>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={openCbsCsvPicker} className="btn" title="CSV: name only OR name + baseCost. Headers supported: name, baseCost"
>
              Import CBS from file (CSV)
            </button>
            <button onClick={addCbsRow} className="btn">+ Add CBS Row</button>
          </div>

          <input
            ref={cbsFileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={onCbsCsvSelected}
          />
        </div>

        <div style={{ marginTop: 10, marginBottom: 10 }} className="text-secondary">
          Base total: <strong className="text-primary">{money(totalBase)}</strong>
        </div>
{/* Correlation modelling (None | Standard) */}
<div style={{ marginTop: 10, marginBottom: 10, padding: 12, border: "1px solid #ddd", borderRadius: 8, background: "#fafafa" }}>
  <div style={{ fontWeight: 800, marginBottom: 6, color: "#111" }}>Correlation modelling</div>

  <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
      <input
        type="radio"
        name="correlationMode"
        value="none"
        checked={correlationMode === "none"}
        onChange={() => {
          setCorrelationMode("none");
          resetResults();
        }}
      />
      <span style={{ fontWeight: 700, color: "#111" }}>None</span>
      <span className="text-muted" style={{ fontSize: 12 }}>(independent)</span>
    </label>

    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
      <input
        type="radio"
        name="correlationMode"
        value="standard"
        checked={correlationMode === "standard"}
        onChange={() => {
          setCorrelationMode("standard");
          resetResults();
        }}
      />
      <span style={{ fontWeight: 700, color: "#111" }}>Standard</span>
      <span className="text-muted" style={{ fontSize: 12 }}>(recommended)</span>
    </label>
  </div>

  <div style={{ marginTop: 6, fontSize: 12, color: "#444" }}>
    {correlationMode === "standard"
      ? "Assign each CBS item to a primary driver and set sensitivity. This models common drivers that cause multiple cost items to move together."
      : "CBS items are treated as independent (no correlation)."}
  </div>
</div>
        <div style={{ fontSize: 12, marginBottom: 10 }} className="text-muted">
          CBS CSV should contain <strong>names and optionally basecost</strong>. You can modify Base Cost and Confidence Factor here.
          If you pick <span className="pill">User defined</span>, you manually enter Best/Most likely/Worst.
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Name</th>
                <th style={th}>Base Cost (AUD)</th>
                <th style={th}>Confidence Factor</th>
                <th style={th}>Best case</th>
                <th style={th}>Most likely</th>
                <th style={th}>Worst case</th>
                {correlationMode === "standard" && <th style={th}>Driver</th>}
                {correlationMode === "standard" && <th style={th}>Sensitivity</th>}
                <th style={th}>Delete</th>
              </tr>
            </thead>
            <tbody>
              {cbsItems.map((row) => {
                const badFactor =
                  !row.confidenceFactor ||
                  EXCLUDED_FACTORS.has(row.confidenceFactor) ||
                  (confidenceFactors.length > 0 && !confidenceSet.has(row.confidenceFactor));

                const baseCostNum = Number(row.baseCost);
                const badBaseCost = Number.isNaN(baseCostNum) || baseCostNum < 0;

                const ud = isUserDefinedFactor(row.confidenceFactor);
                const derived = calcDerivedCosts(row);

                const badUD =
                  ud &&
                  !(
                    Number.isFinite(derived.best) &&
                    Number.isFinite(derived.ml) &&
                    Number.isFinite(derived.worst) &&
                    derived.best >= 0 &&
                    derived.ml >= 0 &&
                    derived.worst >= 0 &&
                    derived.best <= derived.ml &&
                    derived.ml <= derived.worst
                  );

                const derivedCellStyle = {
                  ...input,
                background: "#f3f3f3",
                color: "#111111",
                WebkitTextFillColor: "#111111",
                opacity: 1,
                };


                const udCellStyle = {
                ...input,
                border: badUD ? "2px solid #c00" : "1px solid #ccc",
                background: "#ffffff",
                color: "#111111",
                WebkitTextFillColor: "#111111",
                opacity: 1,
                };


                return (
                  <tr key={row.id}>
                    <td style={td} className="text-secondary" title={row.id}>{row.id}</td>

                    <td style={td}>
                      <input
                        value={row.name}
                        onChange={(e) => updateCbsRow(row.id, { name: e.target.value })}
                        placeholder="e.g., CONSTRUCTION"
                        style={input}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={row.baseCost}
                        onChange={(e) => updateCbsRow(row.id, { baseCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, border: badBaseCost ? "2px solid #c00" : "1px solid #ccc" }}
                        disabled={false}
                      />
                      <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">
                        {money(Number(row.baseCost) || 0)}
                      </div>
                    </td>

                    <td style={td}>
                      <select
                        value={row.confidenceFactor}
                        onChange={(e) => updateCbsRow(row.id, { confidenceFactor: e.target.value })}
                        style={{ ...input, border: badFactor ? "2px solid #c00" : "1px solid #ccc" }}
                      >
                        {confidenceFactors.length === 0 ? (
                          <option value="">Loading…</option>
                        ) : (
                          confidenceFactors.map((k) => (
                            <option key={k} value={k}>{k}</option>
                          ))
                        )}
                      </select>
                      {badFactor && (
                        <div style={{ fontSize: 12, marginTop: 4, color: "#ff6b6b" }}>
                          Choose a valid confidence factor.
                        </div>
                      )}
                      {ud && badUD && (
                        <div style={{ fontSize: 12, marginTop: 4, color: "#ff6b6b" }}>
                          For User defined: ensure Best ≤ Most likely ≤ Worst and all are provided.
                        </div>
                      )}
                    </td>

                    {/* Best / Most likely / Worst */}
                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.bestCaseCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { bestCaseCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.best) ? money(derived.best) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.mostLikelyCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { mostLikelyCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.ml) ? money(derived.ml) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.worstCaseCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { worstCaseCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.worst) ? money(derived.worst) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

{correlationMode === "standard" && (
  <td style={td}>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select
        value={row.driverGroup || ""}
        onChange={(e) => updateCbsRow(row.id, { driverGroup: e.target.value })}
        style={input}
        title={
          row.driverGroup
            ? (DRIVER_TOOLTIPS[row.driverGroup] || "")
            : "Select the primary driver that influences this cost item."
        }
      >
        <option value="">Select driver…</option>
        {DRIVER_OPTIONS.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <span
        title={
          row.driverGroup
            ? (DRIVER_TOOLTIPS[row.driverGroup] || "")
            : "Select a driver to see help text."
        }
        style={{ cursor: "help", fontWeight: 900, color: "#555" }}
        aria-label="Driver help"
      >
        ⓘ
      </span>
    </div>
  </td>
)}

{correlationMode === "standard" && (
  <td style={td}>
    <div style={{ minWidth: 180 }}>
      <input
        type="range"
        min="0"
        max="3"
        step="1"
        value={sensitivityToIndex(row.sensitivity)}
        onChange={(e) => updateCbsRow(row.id, { sensitivity: indexToSensitivity(e.target.value) })}
        style={{ width: "100%" }}
        title="Indicates how strongly this cost item responds to changes in the selected driver."
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", marginTop: 4 }}>
        <span>None</span>
        <span>Low</span>
        <span>Med</span>
        <span>High</span>
      </div>
    </div>
  </td>
)}


                    <td style={td}>
                      <button onClick={() => deleteCbsRow(row.id)} className="iconBtn dangerBtn" title="Delete CBS row" aria-label="Delete CBS row">×</button>
                    </td>
                  </tr>
                );
              })}

              {cbsItems.length === 0 && (
                <tr><td style={td} colSpan={correlationMode === "standard" ? 10 : 8} className="text-secondary">No CBS rows. Import or Add.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Risk Register */}
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }} className="text-primary">Risk register</h2>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={openRisksCsvPicker} className="btn" title="CSV headers: name,riskType(optional),probability,lowCost,mostLikelyCost,highCost">
              Import Risks from file (CSV)
            </button>
            <button onClick={addRiskRow} className="btn">+ Add Risk</button>
          </div>

          <input
            ref={risksFileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={onRisksCsvSelected}
          />
        </div>

        <div style={{ fontSize: 12, marginTop: 10 }} className="text-muted">
          Optional CSV header <code>riskType</code> can be <code>inherent</code> or <code>contingent</code>. If inherent, costs are ignored.
        </div>

        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Risk</th>
                <th style={th}>Risk Type</th>
                <th style={th}>Probability (0–1)</th>
                <th style={th}>Low ($)</th>
                <th style={th}>Most Likely ($)</th>
                <th style={th}>High ($)</th>
                <th style={th}>Delete</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r) => {
                const p = Number(r.probability);
                const badP = Number.isNaN(p) || p < 0 || p > 1;

                const isInherent = String(r.riskType || "contingent").toLowerCase() === "inherent";

                return (
                  <tr key={r.id}>
                    <td style={td} className="text-secondary" title={r.id}>{r.id}</td>

                    <td style={td}>
                      <input
                        value={r.name}
                        onChange={(e) => updateRiskRow(r.id, { name: e.target.value })}
                        placeholder="e.g., Unknown services relocation"
                        style={input}
                      />
                    </td>

                    <td style={td}>
                      <select
                        value={r.riskType || "contingent"}
                        onChange={(e) => updateRiskRow(r.id, { riskType: e.target.value })}
                        style={input}
                      >
                        <option value="contingent">contingent</option>
                        <option value="inherent">inherent</option>
                      </select>
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.probability}
                        onChange={(e) => updateRiskRow(r.id, { probability: e.target.value })}
                        min="0"
                        max="1"
                        step="0.01"
                        style={{ ...input, border: badP ? "2px solid #c00" : "1px solid #ccc" }}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.lowCost}
                        onChange={(e) => updateRiskRow(r.id, { lowCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.mostLikelyCost}
                        onChange={(e) => updateRiskRow(r.id, { mostLikelyCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.highCost}
                        onChange={(e) => updateRiskRow(r.id, { highCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <button onClick={() => deleteRiskRow(r.id)} className="iconBtn dangerBtn" title="Delete risk" aria-label="Delete risk">×</button>
                    </td>
                  </tr>
                );
              })}

              {risks.length === 0 && (
                <tr><td style={td} colSpan={8} className="text-secondary">No risks. Import or Add.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Simulation */}
      <section style={card}>
        <h2 style={{ marginTop: 0 }} className="text-primary">Simulation</h2>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ minWidth: 220 }}>
            <label style={label}>Iterations</label>
            <input
              type="number"
              value={iterations}
              onChange={(e) => setIterations(e.target.value)}
              min="1"
              step="1"
              style={input}
            />
            <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">Tip: 5,000–10,000 is typical.</div>
          </div>

          <div style={{ minWidth: 220 }}>
            <label style={label}>Random seed</label>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              step="1"
              style={input}
            />
            <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">Same seed + same inputs = same results.</div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <button onClick={runSimulation} className="btn" style={{ minWidth: 160 }} disabled={isRunning || isExporting}>
              {isRunning ? "Running…" : "Run Simulation"}
            </button>
          </div>
        </div>

        {errors.length > 0 && (
          <div style={{ background: "#fff3f3", border: "1px solid #f3b5b5", padding: 12, borderRadius: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, color: "#a10000" }}>Validation / API errors / import warnings</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(errors, null, 2)}</pre>
          </div>
        )}

        {results ? (
  <div
    style={{
      marginTop: 12,
      background: "#f7fbff",
      border: "1px solid #cfe4ff",
      padding: 12,
      borderRadius: 8,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700, color: "#111" }}>Results (AUD)</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn" onClick={downloadJson} disabled={!canExport}>
          {isExporting ? "Exporting…" : "Download JSON"}
        </button>
        <button className="btn" onClick={downloadExcel} disabled={!canExport}>
          {isExporting ? "Exporting…" : "Download Excel"}
        </button>
      </div>
    </div>

    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
      <ResultBox label="P5" value={money(results.p5)} />
      <ResultBox label="P10" value={money(results.p10)} />
      <ResultBox label="P50" value={money(results.p50)} />
      <ResultBox label="P90" value={money(results.p90)} />
      <ResultBox
        label="Contingency (P90−P50)"
        value={money(results.contingency_p90_minus_p50)}
      />
    </div>

    {/* --- Sensitivity (Grouped, short) --- */}
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 800, color: "#111", marginBottom: 8 }}>
        Sensitivity (Top drivers)
      </div>

      {(!sensitivity || sensitivity.length === 0) ? (
        <div style={{ fontSize: 12, color: "#444" }}>
          No sensitivity data returned. (Make sure your backend /simulate is returning <code>sensitivity</code>.)
        </div>
      ) : (
        (() => {
          // Grouping logic: "Dominant" >= 0.30 abs_rho, "Moderate" 0.15–0.30
          const dom = sensitivity.filter((d) => Number(d.abs_rho) >= 0.30).slice(0, 8);
          const mod = sensitivity
            .filter((d) => Number(d.abs_rho) >= 0.15 && Number(d.abs_rho) < 0.30)
            .slice(0, 10);

          
          const resolveDisplayName = (row) => {
            if (row.category === "RISK") {
              const r = risks.find(x => x.id === row.name);
              return r ? r.name : row.name;
            }
            if (row.category === "CBS") {
              const c = cbsItems.find(x => x.id === row.name);
              return c ? c.name : row.name;
            }
            return row.name;
          };

const renderTable = (title, rows) => (
            <div style={{ marginTop: 10 }}>
              {/* Ensure legible text on light Results panel */}
              {/* Table defaults to dark-theme text in some browsers; force dark text here */}

              <div style={{ fontWeight: 700, color: "#111", marginBottom: 6 }}>
                {title}{" "}
                <span style={{ fontWeight: 600, color: "#555", fontSize: 12 }}>
                  ({rows.length})
                </span>
              </div>

              {rows.length === 0 ? (
                <div style={{ fontSize: 12, color: "#444" }}>None</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", color: "#111" }}>
                    <thead>
                      <tr>
                        <th style={th}>Rank</th>
                        <th style={th}>Driver</th>
                        <th style={th}>Category</th>
                        <th style={th}>Direction</th>
                        <th style={th}>|ρ|</th>
                        <th style={th}>ρ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const abs = Number(r.abs_rho) || 0;
                        const rho = Number(r.spearman_rho) || 0;
                        const sign = rho >= 0 ? "+" : "-";
                        return (
                          <tr key={`${title}-${r.name}-${i}`}>
                            <td style={{ ...td, color: "#111" }}>{i + 1}</td>
                            <td style={td}>
                              <div style={{ fontWeight: 800, color: "#111" }}>
                                {resolveDisplayName(r)}
                              </div>
                              <div style={{ fontSize: 12, color: "#555" }}>
                                {r.name}
                              </div>
                            </td>
                            <td style={{ ...td, color: "#111" }}>{r.category}</td>
                            <td style={{ ...td, color: "#111" }}>
                              <span style={{ fontWeight: 800, color: "#111" }}>
                                {sign}
                              </span>
                            </td>
                            <td style={{ ...td, color: "#111" }}>{abs.toFixed(3)}</td>
                            <td style={{ ...td, color: "#111" }}>{rho.toFixed(3)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );

          return (
            <div>
              <div style={{ fontSize: 12, color: "#444" }}>
                Grouping rules: <strong>Dominant</strong> (|ρ| ≥ 0.30),{" "}
                <strong>Moderate</strong> (0.15 ≤ |ρ| &lt; 0.30). (Spearman rank correlation.)
              </div>

              {renderTable("Dominant drivers", dom)}
              {renderTable("Moderately dominant drivers", mod)}
            </div>
          );
        })()
      )}
    </div>

    <div style={{ marginTop: 10, fontSize: 12, color: "#444" }}>
          {/* --- Commentary (AI) --- */}
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 800, color: "#111", marginBottom: 8 }}>
        Commentary {commentaryMode ? <span className="pill">{commentaryMode}</span> : null}
      </div>

      {isCommentaryRunning ? (
        <div style={{ fontSize: 12, color: "#444" }}>Generating commentary…</div>
      ) : commentary ? (
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "#111", lineHeight: 1.35 }}>
          {commentary}
        </pre>
      ) : (
        <div style={{ fontSize: 12, color: "#444" }}>
          Commentary will appear here after you run a simulation.
        </div>
      )}

      {commentaryError ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "#a10000" }}>
          Commentary error: {commentaryError}
        </div>
      ) : null}
    </div>
      Downloads are enabled only after running a simulation.
    </div>
  </div>
) : (
  <div style={{ marginTop: 12, fontSize: 12 }} className="text-muted">
    {isRunning ? "Running simulation…" : "No results yet. Click Run Simulation."}
  </div>
)}

      </section>
    </div>
  );
}

function ResultBox({ label, value }) {
  return (
    <div
      style={{
        border: "1px solid #d7e7ff",
        borderRadius: 10,
        padding: 12,
        minWidth: 180,
        background: "#ffffff",
        color: "#111111",
      }}
    >
      <div style={{ fontSize: 12, color: "#333" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6, color: "#111" }}>
        {value}
      </div>
    </div>
  );
}

const card = { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 18 };
const table = { width: "100%", borderCollapse: "collapse" };
const th = {
  textAlign: "left",
  borderBottom: "1px solid #444",
  padding: "10px 8px",
  background: "#2f2f2f",
  color: "#ffffff",
  fontWeight: 700,
  fontSize: 13,
};
const td = { borderBottom: "1px solid #eee", padding: "10px 8px", verticalAlign: "top" };
const input = {
  width: "100%",
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
  boxSizing: "border-box",
  background: "#ffffff",
  color: "#111111",
};
const label = { display: "block", fontSize: 12, color: "#bdbdbd", marginBottom: 6 };

export default App;
