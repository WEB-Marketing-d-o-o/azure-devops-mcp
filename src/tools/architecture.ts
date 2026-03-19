import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../logger.js";

// ─── Tool names ──────────────────────────────────────────────────────────────

export const ARCHITECTURE_SCAN = "project_architecture_scan";
export const ARCHITECTURE_READ_FILE = "project_architecture_read_file";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FolderNode {
  name: string;
  relativePath: string;
  inferredLayer: string;
  fileCount: number;
  filesByExtension: Record<string, number>;
  children: FolderNode[];
}

interface CsprojInfo {
  name: string;
  relativePath: string;
  targetFramework: string | null;
  outputType: string | null;
  projectReferences: string[];
  packageReferences: Array<{ name: string; version: string }>;
}

interface NuGetPackage {
  id: string;
  version: string;
  source: string; // which packages.config it came from
}

interface CsProperty {
  name: string;
  type: string;
  accessModifier: string;
  hasGetter: boolean;
  hasSetter: boolean;
  isComputed: boolean;
  attributes: string[];
}

interface CsField {
  name: string;
  type: string;
  modifier: string;
}

interface CsMethod {
  name: string;
  returnType: string;
  accessModifier: string;
  isStatic: boolean;
  isAsync: boolean;
  isOverride: boolean;
  parameters: Array<{ name: string; type: string }>;
  attributes: string[];
}

interface CsConstructor {
  accessModifier: string;
  parameters: Array<{ name: string; type: string }>;
  callsBase: boolean;
  baseArguments: string;
}

interface CsClassInfo {
  name: string;
  namespace: string;
  relativePath: string;
  kind: "class" | "interface" | "enum" | "record" | "struct";
  accessModifier: string;
  isStatic: boolean;
  isAbstract: boolean;
  isSealed: boolean;
  isPartial: boolean;
  baseTypes: string[];
  interfaces: string[];
  classAttributes: string[];
  constructors: CsConstructor[];
  fields: CsField[];
  properties: CsProperty[];
  methods: CsMethod[];
  enumValues: string[];
}

interface HttpHandlerInfo {
  name: string;
  relativePath: string;
  className: string | null;
  interfaces: string[];
  hasSessionState: boolean;
}

interface AspxPageInfo {
  name: string;
  relativePath: string;
  codeBehindRelativePath: string | null;
  hasCodeBehind: boolean;
}

interface AscxControlInfo {
  name: string;
  relativePath: string;
  codeBehindRelativePath: string | null;
}

interface WebConfigKey {
  key: string;
  hasValue: boolean;
  isCrypted: boolean;
  isConnectionString: boolean;
}

interface WemFrameworkDependency {
  dllName: string;
  source: "root-bin" | "common-bin" | "easiedit-bin";
}

interface ProjectScanResult {
  scannedAt: string;
  rootPath: string;
  repoName: string;
  projectType: string; // "WEM EasyEditCms Site" | "WEM EasyEditCms Framework" | "Unknown"
  summary: {
    totalFiles: number;
    csFiles: number;
    csprojFiles: number;
    ashxFiles: number;
    aspxFiles: number;
    ascxFiles: number;
    xmlDefinitions: number;
    configFiles: string[];
    hasDocker: boolean;
    hasBlazor: boolean;
    hasUiTests: boolean;
    hasUnitTests: boolean;
    hasScraper: boolean;
  };
  folderTree: FolderNode;
  projects: CsprojInfo[];
  nugetPackages: NuGetPackage[];
  wemFrameworkDependencies: WemFrameworkDependency[];
  classes: CsClassInfo[];
  httpHandlers: HttpHandlerInfo[];
  aspxPages: AspxPageInfo[];
  ascxControls: AscxControlInfo[];
  webConfigKeys: WebConfigKey[];
  xmlDefinitionFiles: string[];
  uiTestBaseApiMethods: string[];
  detectedPatterns: string[];
  keyFiles: Record<string, string>; // logical name -> relative path
}

// ─── Layer heuristics ─────────────────────────────────────────────────────────

const LAYER_PATTERNS: Array<[RegExp, string]> = [
  [/controller/i, "Prezentacijski sloj"],
  [/usercontrol/i, "Prezentacijski sloj"],
  [/pagepart/i, "Prezentacijski sloj"],
  [/usercontrol/i, "Prezentacijski sloj"],
  [/handler/i, "Integracijski sloj"],
  [/api/i, "Integracijski sloj"],
  [/apiextend/i, "Integracijski sloj"],
  [/cubisadapt/i, "Integracijski sloj"],
  [/wienerclient/i, "Integracijski sloj"],
  [/wingclient/i, "Integracijski sloj"],
  [/service/i, "Poslovni sloj"],
  [/engine/i, "Poslovni sloj"],
  [/manager/i, "Poslovni sloj"],
  [/worker/i, "Poslovni sloj"],
  [/scraper/i, "Poslovni sloj"],
  [/ticketing/i, "Poslovni sloj"],
  [/chatbot/i, "Poslovni sloj"],
  [/repository/i, "Sloj podataka"],
  [/data/i, "Sloj podataka"],
  [/context/i, "Sloj podataka"],
  [/migration/i, "Sloj podataka"],
  [/cache/i, "Sloj podataka"],
  [/model/i, "Modeli i entiteti"],
  [/entity/i, "Modeli i entiteti"],
  [/dto/i, "Modeli i entiteti"],
  [/domain/i, "Modeli i entiteti"],
  [/intranet/i, "Modeli i entiteti"],
  [/test/i, "Testovi"],
  [/spec/i, "Testovi"],
  [/uitest/i, "UI Testovi"],
  [/unittest/i, "Unit Testovi"],
  [/util/i, "Pomoćni alati"],
  [/helper/i, "Pomoćni alati"],
  [/extension/i, "Pomoćni alati"],
  [/extender/i, "Pomoćni alati"],
  [/config/i, "Konfiguracija"],
  [/setting/i, "Konfiguracija"],
  [/shared/i, "Dijeljene komponente"],
  [/common/i, "Dijeljene komponente"],
  [/infrastructure/i, "Infrastruktura"],
  [/sso/i, "Infrastruktura"],
  [/auth/i, "Infrastruktura"],
];

function inferLayer(name: string): string {
  for (const [pattern, layer] of LAYER_PATTERNS) {
    if (pattern.test(name)) return layer;
  }
  return "Nesvrstano";
}

// ─── Skip logic ───────────────────────────────────────────────────────────────

// Directories to always skip regardless of depth
const ALWAYS_SKIP = new Set([
  ".git",
  ".vs",
  ".github",
  "node_modules",
  "TestResults",
  "EasyEditCmsSync", // tool project inside EasyEdit
]);

// Directories to skip only at shallow depth (root or one level deep)
const SHALLOW_SKIP = new Set(["bin", "obj", "packages"]);

function shouldSkipDir(name: string, depth: number): boolean {
  if (name.startsWith(".")) return true;
  if (ALWAYS_SKIP.has(name)) return true;
  // bin/obj/packages at depth 0 (root) and depth 1 (e.g. Common/bin)
  // but NOT at depth 2+ (e.g. UiTest/bin/Debug has useful chromedriver info)
  if (SHALLOW_SKIP.has(name) && depth <= 1) return true;
  return false;
}

// ─── Filesystem walker ────────────────────────────────────────────────────────

function walkDirectory(dirPath: string, rootPath: string, depth: number, maxDepth: number): FolderNode {
  const name = path.basename(dirPath);
  const node: FolderNode = {
    name,
    relativePath: path.relative(rootPath, dirPath) || ".",
    inferredLayer: inferLayer(name),
    fileCount: 0,
    filesByExtension: {},
    children: [],
  };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return node;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, depth)) continue;
      if (depth < maxDepth) {
        const child = walkDirectory(fullPath, rootPath, depth + 1, maxDepth);
        node.fileCount += child.fileCount;
        for (const [ext, count] of Object.entries(child.filesByExtension)) {
          node.filesByExtension[ext] = (node.filesByExtension[ext] ?? 0) + count;
        }
        node.children.push(child);
      }
    } else {
      const ext = path.extname(entry.name) || "(bez ekstenzije)";
      node.filesByExtension[ext] = (node.filesByExtension[ext] ?? 0) + 1;
      node.fileCount++;
    }
  }

  return node;
}

// ─── File finder ──────────────────────────────────────────────────────────────

function findFiles(dir: string, predicate: (name: string) => boolean, skipDirFn?: (name: string, depth: number) => boolean, depth = 0): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = skipDirFn ? skipDirFn(entry.name, depth) : shouldSkipDir(entry.name, depth);
      if (!skip) {
        results.push(...findFiles(fullPath, predicate, skipDirFn, depth + 1));
      }
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Project type detector ────────────────────────────────────────────────────

function detectProjectType(rootPath: string): string {
  const hasSrc = fs.existsSync(path.join(rootPath, "src"));
  const hasServices = fs.existsSync(path.join(rootPath, "src", "Services.Interfaces"));
  if (hasSrc && hasServices) return "WEM EasyEditCms Framework";

  const hasEasyEdit = fs.existsSync(path.join(rootPath, "EasyEdit"));
  const hasUserControls = fs.existsSync(path.join(rootPath, "UserControls"));
  if (hasEasyEdit && hasUserControls) return "WEM EasyEditCms Site";

  return "Unknown";
}

// ─── Key files map ────────────────────────────────────────────────────────────

function buildKeyFiles(rootPath: string): Record<string, string> {
  const candidates: Record<string, string> = {
    "Global.asax startup": "Global.asax.cs",
    "DI registracija servisa": "ServicesRegistration.cs",
    "Web konfiguracija": "Web.config",
    "NuGet paketi (root)": "packages.config",
    "NuGet paketi (Common)": path.join("Common", "packages.config"),
    "Common csproj": (() => {
      try {
        const found = fs.readdirSync(path.join(rootPath, "Common")).find((f) => f.endsWith(".csproj"));
        return found ? `Common${path.sep}${found}` : "";
      } catch {
        return "";
      }
    })(),
  };

  const result: Record<string, string> = {};
  for (const [label, rel] of Object.entries(candidates)) {
    if (rel && fs.existsSync(path.join(rootPath, rel))) {
      result[label] = rel;
    }
  }

  // UiTest XML docs
  const uiTestXml = findFiles(
    rootPath,
    (n) => n === "WEM.EasyEditCms.Common.UiTest.xml",
    (name, depth) => shouldSkipDir(name, depth)
  );
  if (uiTestXml.length > 0) {
    result["UiTest BaseUiTest XML dokumentacija"] = path.relative(rootPath, uiTestXml[0]);
  }

  return result;
}

// ─── .csproj parser ───────────────────────────────────────────────────────────

function parseCsproj(filePath: string, rootPath: string): CsprojInfo {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {}

  const projectRefs = [...content.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => path.basename(m[1], ".csproj"));

  const packageRefs = [...content.matchAll(/<PackageReference\s+Include="([^"]+)"[^>]*(?:Version="([^"]*)")?/g)].map((m) => ({ name: m[1], version: m[2] ?? "" }));

  return {
    name: path.basename(filePath, ".csproj"),
    relativePath: path.relative(rootPath, filePath),
    targetFramework: content.match(/<TargetFramework[^>]*>([^<]+)<\/TargetFramework>/)?.[1] ?? null,
    outputType: content.match(/<OutputType[^>]*>([^<]+)<\/OutputType>/)?.[1] ?? null,
    projectReferences: projectRefs,
    packageReferences: packageRefs,
  };
}

// ─── packages.config parser ───────────────────────────────────────────────────

function parseAllPackagesConfigs(rootPath: string): NuGetPackage[] {
  const locations = [
    { file: path.join(rootPath, "packages.config"), source: "root" },
    { file: path.join(rootPath, "Common", "packages.config"), source: "Common" },
    { file: path.join(rootPath, "UnitTest", "packages.config"), source: "UnitTest" },
  ];

  const packages: NuGetPackage[] = [];
  for (const { file, source } of locations) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      for (const m of content.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g)) {
        packages.push({ id: m[1], version: m[2], source });
      }
    } catch {}
  }
  return packages;
}

// ─── WEM framework dependency detector ───────────────────────────────────────

function detectWemFrameworkDeps(rootPath: string): WemFrameworkDependency[] {
  const sources: Array<{ dir: string; source: WemFrameworkDependency["source"] }> = [
    { dir: path.join(rootPath, "bin"), source: "root-bin" },
    { dir: path.join(rootPath, "Common", "bin"), source: "common-bin" },
    { dir: path.join(rootPath, "EasyEdit", "bin"), source: "easiedit-bin" },
  ];

  const deps: WemFrameworkDependency[] = [];
  for (const { dir, source } of sources) {
    try {
      const dlls = fs.readdirSync(dir).filter((f) => f.endsWith(".dll") && f.startsWith("WEM."));
      for (const dll of dlls) {
        deps.push({ dllName: dll.replace(".dll", ""), source });
      }
    } catch {}
  }
  return deps;
}

// ─── .cs parser ───────────────────────────────────────────────────────────────

function parseParameters(raw: string): Array<{ name: string; type: string }> {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((p) => {
      const clean = p.trim().replace(/\s*=\s*[^,]+$/, ""); // strip default values
      const parts = clean.trim().split(/\s+/);
      const name = parts[parts.length - 1]?.replace(/^[@]/, "") ?? "";
      const type = parts.slice(0, -1).join(" ") || "unknown";
      return { name, type };
    })
    .filter((p) => p.name && !["", ")", "("].includes(p.name));
}

function parseCsFile(filePath: string, rootPath: string): CsClassInfo | null {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Strip comments
  const stripped = content.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

  // Namespace
  const namespace = stripped.match(/namespace\s+([\w.]+)/)?.[1] ?? "(nepoznat)";

  // Type declaration
  const kindMatch = stripped.match(/\b(public|internal|private|protected)?\s*((?:abstract|sealed|static|partial)\s+)*(class|interface|enum|record|struct)\s+(\w+)/);
  if (!kindMatch) return null;

  const accessModifier = kindMatch[1] ?? "internal";
  const modifiers = (kindMatch[2] ?? "").toLowerCase();
  const kind = kindMatch[3] as CsClassInfo["kind"];
  const name = kindMatch[4];

  // Base types
  const declLine = stripped.match(new RegExp(`(?:${kind})\\s+${name}\\s*(?:<[^>]*>)?\\s*([^{]*)`))?.[1] ?? "";
  const colonPart = declLine.match(/:\s*([^{where]+)/)?.[1] ?? "";
  const allBaseTypes = colonPart
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/\s*where\s.*/s, "")
        .trim()
    )
    .filter(Boolean);

  const interfaces = allBaseTypes.filter((t) => /^I[A-Z]/.test(t));
  const baseTypes = allBaseTypes.filter((t) => !interfaces.includes(t));

  // Class attributes (last 3 before the declaration)
  const declIdx = stripped.indexOf(kindMatch[0]);
  const beforeDecl = stripped.substring(Math.max(0, declIdx - 500), declIdx);
  const classAttributes = [...beforeDecl.matchAll(/\[([^\]]+)\]/g)].slice(-3).map((m) => m[1].trim());

  // Enum values
  const enumValues: string[] = [];
  if (kind === "enum") {
    const bodyMatch = stripped.match(/enum\s+\w+[^{]*\{([^}]*)\}/s);
    if (bodyMatch) {
      enumValues.push(
        ...bodyMatch[1]
          .split(",")
          .map((v) => v.trim().split(/[\s=]/)[0].trim())
          .filter(Boolean)
      );
    }
  }

  // Constructors
  const constructors: CsConstructor[] = [];
  const ctorRegex = new RegExp(`(public|private|protected|internal)\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::\\s*(base|this)\\s*\\(([^)]*)\\))?`, "g");
  let ctorMatch: RegExpExecArray | null;
  while ((ctorMatch = ctorRegex.exec(stripped)) !== null) {
    constructors.push({
      accessModifier: ctorMatch[1],
      parameters: parseParameters(ctorMatch[2]),
      callsBase: ctorMatch[3] === "base",
      baseArguments: ctorMatch[4] ?? "",
    });
  }

  // Properties
  const properties: CsProperty[] = [];
  const propRegex =
    /(\[[^\]]+\]\s*)*\s*(public|private|protected|internal|protected\s+internal|private\s+protected)\s+((?:static|virtual|override|abstract|new|readonly)\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\{([^}]*)\}/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRegex.exec(stripped)) !== null) {
    const propName = propMatch[5];
    if (["get", "set", "add", "remove", "value", "if", "else", "return"].includes(propName)) continue;
    const body = propMatch[6];
    const attrBlock = propMatch[1] ?? "";
    const attrs = [...attrBlock.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
    properties.push({
      name: propName,
      type: propMatch[4].trim(),
      accessModifier: propMatch[2],
      hasGetter: body.includes("get"),
      hasSetter: body.includes("set"),
      isComputed: body.includes("return") || body.includes("=>"),
      attributes: attrs,
    });
  }

  // Fields
  const fields: CsField[] = [];
  const fieldRegex = /^\s*(public|private|protected|internal|protected\s+internal)\s+(static\s+|readonly\s+|const\s+|static\s+readonly\s+)*([\w<>\[\]?,\s]+?)\s+(_?\w+)\s*(?:=|;)/gm;
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = fieldRegex.exec(stripped)) !== null) {
    const fieldName = fieldMatch[4];
    if (fieldName === name) continue;
    fields.push({
      modifier: (fieldMatch[1] + " " + (fieldMatch[2] ?? "")).trim(),
      type: fieldMatch[3].trim(),
      name: fieldName,
    });
  }

  // Methods
  const methods: CsMethod[] = [];
  const SKIP_KEYWORDS = new Set(["get", "set", "add", "remove", name, "if", "while", "for", "foreach", "switch", "catch", "using", "return", "new"]);
  const methodRegex =
    /(\[[^\]]+\]\s*)*\s*(public|private|protected|internal|protected\s+internal)\s+((?:static|virtual|override|abstract|async|sealed|new)\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:where[^{;]*)?\s*[{;]/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodRegex.exec(stripped)) !== null) {
    const methodName = methodMatch[5];
    if (SKIP_KEYWORDS.has(methodName)) continue;
    const modStr = (methodMatch[3] ?? "").toLowerCase();
    const attrBlock = methodMatch[1] ?? "";
    const attrs = [...attrBlock.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
    methods.push({
      name: methodName,
      returnType: methodMatch[4].trim(),
      accessModifier: methodMatch[2],
      isStatic: modStr.includes("static"),
      isAsync: modStr.includes("async"),
      isOverride: modStr.includes("override"),
      parameters: parseParameters(methodMatch[6]),
      attributes: attrs,
    });
  }

  return {
    name,
    namespace,
    relativePath: path.relative(rootPath, filePath),
    kind,
    accessModifier,
    isStatic: modifiers.includes("static"),
    isAbstract: modifiers.includes("abstract"),
    isSealed: modifiers.includes("sealed"),
    isPartial: modifiers.includes("partial"),
    baseTypes,
    interfaces,
    classAttributes,
    constructors,
    fields,
    properties,
    methods,
    enumValues,
  };
}

// ─── .ashx parser ─────────────────────────────────────────────────────────────

function parseAshxFile(filePath: string, rootPath: string): HttpHandlerInfo {
  const name = path.basename(filePath, ".ashx");
  const codeBehindPath = filePath + ".cs";
  let className: string | null = null;
  const interfaces: string[] = [];
  let hasSessionState = false;

  try {
    const content = fs.readFileSync(codeBehindPath, "utf-8");
    className = content.match(/class\s+(\w+)/)?.[1] ?? null;
    hasSessionState = content.includes("IRequiresSessionState");
    const implMatch = content.match(/class\s+\w+\s*:\s*([^{]+)/);
    if (implMatch) {
      interfaces.push(
        ...implMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  } catch {}

  return {
    name,
    relativePath: path.relative(rootPath, filePath),
    className,
    interfaces,
    hasSessionState,
  };
}

// ─── ASPX / ASCX parsers ──────────────────────────────────────────────────────

function parseAspxFiles(files: string[], rootPath: string): AspxPageInfo[] {
  return files.map((f) => {
    const codeBehind = f + ".cs";
    return {
      name: path.basename(f, ".aspx"),
      relativePath: path.relative(rootPath, f),
      codeBehindRelativePath: fs.existsSync(codeBehind) ? path.relative(rootPath, codeBehind) : null,
      hasCodeBehind: fs.existsSync(codeBehind),
    };
  });
}

function parseAscxFiles(files: string[], rootPath: string): AscxControlInfo[] {
  return files.map((f) => {
    const codeBehind = f + ".cs";
    return {
      name: path.basename(f, ".ascx"),
      relativePath: path.relative(rootPath, f),
      codeBehindRelativePath: fs.existsSync(codeBehind) ? path.relative(rootPath, codeBehind) : null,
    };
  });
}

// ─── Web.config parser ────────────────────────────────────────────────────────

function parseWebConfig(rootPath: string): WebConfigKey[] {
  const configPath = path.join(rootPath, "Web.config");
  let content = "";
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }

  const keys: WebConfigKey[] = [];

  for (const m of content.matchAll(/<add\s+key="([^"]+)"\s+value="([^"]*)"/g)) {
    keys.push({
      key: m[1],
      hasValue: m[2].length > 0,
      isCrypted: m[1].toLowerCase().includes("crypt"),
      isConnectionString: false,
    });
  }

  for (const m of content.matchAll(/<add\s+name="([^"]+)"\s+connectionString="([^"]*)"/g)) {
    keys.push({
      key: m[1],
      hasValue: m[2].length > 0,
      isCrypted: false,
      isConnectionString: true,
    });
  }

  return keys;
}

// ─── UiTest BaseUiTest API docs ───────────────────────────────────────────────

function parseUiTestApiDocs(rootPath: string): string[] {
  const candidates = findFiles(
    rootPath,
    (n) => n === "WEM.EasyEditCms.Common.UiTest.xml",
    (name, depth) => shouldSkipDir(name, depth)
  );

  const methods: string[] = [];
  for (const xmlPath of candidates) {
    try {
      const content = fs.readFileSync(xmlPath, "utf-8");
      for (const m of content.matchAll(/<member name="M:([^"]+)">/g)) {
        methods.push(m[1]);
      }
    } catch {}
  }
  return methods;
}

// ─── Pattern detector ─────────────────────────────────────────────────────────

function detectPatterns(classes: CsClassInfo[], rootPath: string): string[] {
  const patterns: string[] = [];

  if (classes.some((c) => c.name.endsWith("Controller") || c.baseTypes.some((b) => b.includes("Controller")))) patterns.push("MVC / Web Forms Controllers");

  if (classes.some((c) => c.interfaces.some((i) => i.includes("IRequestHandler")) || c.name.endsWith("Handler"))) patterns.push("HTTP Handler Pattern (ASHX)");

  if (classes.some((c) => c.name.endsWith("Repository") || c.interfaces.some((i) => i.includes("IRepository")))) patterns.push("Repository Pattern");

  if (classes.some((c) => c.name.endsWith("Service"))) patterns.push("Service Layer Pattern");

  if (classes.some((c) => c.name.endsWith("Engine"))) patterns.push("Engine Pattern");

  if (classes.some((c) => c.name.endsWith("Worker"))) patterns.push("Worker Pattern");

  if (classes.some((c) => c.name.endsWith("Factory") || c.interfaces.some((i) => i.includes("IFactory")))) patterns.push("Factory Pattern");

  if (classes.some((c) => c.classAttributes.some((a) => a.includes("Serializable")))) patterns.push("File System Serialization (Cart/Session)");

  if (classes.some((c) => c.interfaces.some((i) => i === "IScraper") || c.name.includes("Scraper"))) patterns.push("Web Scraper Pattern");

  if (classes.some((c) => c.baseTypes.some((b) => b.includes("CatalogItem")) || c.name.includes("CatalogItemCustom"))) patterns.push("WEM CatalogItem nasljeđivanje");

  if (classes.some((c) => c.baseTypes.some((b) => b.includes("IntranetUser")) || c.name.includes("IntranetUserCustom"))) patterns.push("WEM IntranetUser nasljeđivanje");

  if (classes.some((c) => c.baseTypes.some((b) => b.includes("ItemBase")))) patterns.push("WEM ItemBase nasljeđivanje");

  if (
    findFiles(
      rootPath,
      (n) => n.endsWith(".razor"),
      (name, depth) => shouldSkipDir(name, depth)
    ).length > 0
  )
    patterns.push("Blazor / Razor Components");

  if (fs.existsSync(path.join(rootPath, "Dockerfile"))) patterns.push("Docker kontejnerizacija");

  return patterns;
}

// ─── Main scan handler ────────────────────────────────────────────────────────

async function handleScan(params: { rootPath: string; maxDepth?: number }): Promise<string> {
  const { rootPath, maxDepth = 5 } = params;

  if (!fs.existsSync(rootPath)) {
    return JSON.stringify({ error: `Putanja ne postoji: ${rootPath}` });
  }

  logger.debug("Pokretanje skeniranja arhitekture", { rootPath, maxDepth });

  // Project type
  const projectType = detectProjectType(rootPath);

  // Folder tree
  const tree = walkDirectory(rootPath, rootPath, 0, maxDepth);

  // .csproj projects
  const csprojFiles = findFiles(
    rootPath,
    (n) => n.endsWith(".csproj"),
    (name, depth) => shouldSkipDir(name, depth)
  );
  const projects = csprojFiles.map((f) => parseCsproj(f, rootPath));

  // NuGet packages (from packages.config files, not NuGet folder)
  const nugetPackages = parseAllPackagesConfigs(rootPath);

  // WEM framework dependencies
  const wemFrameworkDependencies = detectWemFrameworkDeps(rootPath);

  // C# classes — skip Designer files and generated files
  const csFiles = findFiles(
    rootPath,
    (n) => n.endsWith(".cs") && !n.endsWith(".Designer.cs") && !n.endsWith(".designer.cs"),
    (name, depth) => shouldSkipDir(name, depth)
  );
  const classes = csFiles.map((f) => parseCsFile(f, rootPath)).filter((c): c is CsClassInfo => c !== null);

  // HTTP Handlers
  const ashxFiles = findFiles(
    rootPath,
    (n) => n.endsWith(".ashx"),
    (name, depth) => shouldSkipDir(name, depth)
  );
  const httpHandlers = ashxFiles.map((f) => parseAshxFile(f, rootPath));

  // ASPX pages (root level + UserControls, not EasyEdit backend)
  const aspxFiles = findFiles(
    rootPath,
    (n) => n.endsWith(".aspx"),
    (name, depth) => {
      if (name === "EasyEdit" && depth === 0) return true; // skip EasyEdit backend aspx
      return shouldSkipDir(name, depth);
    }
  );
  const aspxPages = parseAspxFiles(aspxFiles, rootPath);

  // ASCX controls
  const ascxFiles = findFiles(
    rootPath,
    (n) => n.endsWith(".ascx"),
    (name, depth) => {
      if (name === "EasyEdit" && depth === 0) return true;
      return shouldSkipDir(name, depth);
    }
  );
  const ascxControls = parseAscxFiles(ascxFiles, rootPath);

  // Web.config
  const webConfigKeys = parseWebConfig(rootPath);

  // EasyEdit/XML definitions
  const xmlDefPath = path.join(rootPath, "EasyEdit", "XML");
  let xmlDefinitionFiles: string[] = [];
  if (fs.existsSync(xmlDefPath)) {
    try {
      xmlDefinitionFiles = fs
        .readdirSync(xmlDefPath)
        .filter((f) => f.endsWith(".xml") || f.endsWith(".json"))
        .sort();
    } catch {}
  }

  // UiTest BaseUiTest API docs
  const uiTestBaseApiMethods = parseUiTestApiDocs(rootPath);

  // Detected patterns
  const detectedPatterns = detectPatterns(classes, rootPath);

  // Key files
  const keyFiles = buildKeyFiles(rootPath);

  // Summary
  const hasDocker = fs.existsSync(path.join(rootPath, "Dockerfile"));
  const hasBlazor =
    findFiles(
      rootPath,
      (n) => n.endsWith(".razor"),
      (name, depth) => shouldSkipDir(name, depth)
    ).length > 0;
  const hasUiTests = fs.existsSync(path.join(rootPath, "UiTest"));
  const hasUnitTests = fs.existsSync(path.join(rootPath, "UnitTest"));
  const hasScraper = classes.some((c) => c.name.includes("Scraper") || c.interfaces.some((i) => i === "IScraper"));

  const configFiles = ["Web.config", "Web.Debug.config", "Web.Release.config", "Web.Sandbox.config", "Web.AutomatedTesting.config", "app.config", "appsettings.json", "packages.config"].filter((f) =>
    fs.existsSync(path.join(rootPath, f))
  );

  const result: ProjectScanResult = {
    scannedAt: new Date().toISOString(),
    rootPath,
    repoName: path.basename(rootPath),
    projectType,
    summary: {
      totalFiles: tree.fileCount,
      csFiles: csFiles.length,
      csprojFiles: csprojFiles.length,
      ashxFiles: ashxFiles.length,
      aspxFiles: aspxFiles.length,
      ascxFiles: ascxFiles.length,
      xmlDefinitions: xmlDefinitionFiles.length,
      configFiles,
      hasDocker,
      hasBlazor,
      hasUiTests,
      hasUnitTests,
      hasScraper,
    },
    folderTree: tree,
    projects,
    nugetPackages,
    wemFrameworkDependencies,
    classes,
    httpHandlers,
    aspxPages,
    ascxControls,
    webConfigKeys,
    xmlDefinitionFiles,
    uiTestBaseApiMethods,
    detectedPatterns,
    keyFiles,
  };

  logger.debug("Skeniranje završeno", {
    projectType,
    classes: classes.length,
    projects: projects.length,
    handlers: httpHandlers.length,
    nuget: nugetPackages.length,
  });

  return JSON.stringify(result, null, 2);
}

// ─── Read file handler ────────────────────────────────────────────────────────

async function handleReadFile(params: { rootPath: string; relativePath: string; maxLines?: number }): Promise<string> {
  const { rootPath, relativePath, maxLines = 500 } = params;

  const fullPath = path.join(rootPath, relativePath);
  const resolvedRoot = path.resolve(rootPath);
  const resolvedFile = path.resolve(fullPath);

  if (!resolvedFile.startsWith(resolvedRoot)) {
    return JSON.stringify({ error: "Nije dopušten pristup izvan korijenskog direktorija." });
  }

  if (!fs.existsSync(fullPath)) {
    return JSON.stringify({ error: `Datoteka ne postoji: ${relativePath}` });
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return JSON.stringify({ error: `Putanja je direktorij: ${relativePath}` });
  }

  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const truncated = lines.length > maxLines;

    return JSON.stringify({
      relativePath,
      totalLines: lines.length,
      truncated,
      truncatedAt: truncated ? maxLines : null,
      content: truncated ? lines.slice(0, maxLines).join("\n") : content,
    });
  } catch (e: any) {
    return JSON.stringify({ error: `Greška pri čitanju: ${e.message}` });
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ScanSchema = z.object({
  rootPath: z.string().describe("Apsolutna putanja do korijenskog direktorija repozitorija (npr. C:/dev/WEM.EasyEditCms.Sites.Default)"),
  maxDepth: z.number().default(5).optional().describe("Maksimalna dubina rekurzivnog prolaska kroz direktorije (default: 5)"),
});

const ReadFileSchema = z.object({
  rootPath: z.string().describe("Apsolutna putanja do korijenskog direktorija (ista kao pri skeniranju)"),
  relativePath: z
    .string()
    .describe(
      "Relativna putanja do datoteke unutar repozitorija. " +
        "Primjeri: 'Common/Classes/CatalogItemCustom.cs', 'Web.config', " +
        "'Global.asax.cs', 'ServicesRegistration.cs', " +
        "'EasyEdit/XML/CatalogPage.xml', 'Handlers/CartHandler.ashx.cs'"
    ),
  maxLines: z
    .number()
    .default(500)
    .optional()
    .describe("Maksimalni broj linija za čitanje (default: 500). " + "Povećaj na 1000+ za velike datoteke poput CatalogItemCustom.cs."),
});

// ─── Registration ─────────────────────────────────────────────────────────────

export function configureArchitectureTools(server: McpServer): void {
  server.tool(
    ARCHITECTURE_SCAN,
    [
      "Skenira arhitekturu WEM EasyEditCms repozitorija i vraća strukturirani JSON koji sadrži:",
      "",
      "• Tip projekta (WEM EasyEditCms Site / Framework)",
      "• Kompletnu strukturu direktorija s inferiranim slojevima na hrvatskom",
      "• Sve .csproj projekte s ovisnostima",
      "• NuGet pakete iz packages.config (ne iz NuGet foldera)",
      "• WEM framework DLL ovisnosti iz bin/ direktorija",
      "• Sve C# klase, sučelja, enume s potpisima metoda i svojstava",
      "• HTTP handlere (.ashx) s implementiranim sučeljima",
      "• ASPX stranice i ASCX user controle (bez EasyEdit backenda)",
      "• Web.config ključeve (bez vrijednosti)",
      "• XML definicije tipova stranica iz EasyEdit/XML/",
      "• API metode BaseUiTest klase (iz XML dokumentacije)",
      "• Detektirane arhitekturalne obrasce",
      "• Ključne datoteke s relativnim putanjama za brzo čitanje",
      "",
      "NAPOMENA: Tool NE čita tijela metoda. Za logiku, DI registracije, Web.config",
      "vrijednosti i startup sekvencu pozovi project_architecture_read_file.",
    ].join("\n"),
    ScanSchema.shape,
    async (params) => ({
      content: [{ type: "text", text: await handleScan(params) }],
    })
  );

  server.tool(
    ARCHITECTURE_READ_FILE,
    [
      "Čita sadržaj jedne datoteke iz repozitorija.",
      "Koristi se NAKON project_architecture_scan za detalje koje scan ne pruža:",
      "",
      "• Tijela metoda (getter logika, computed properties, poslovne pravilo)",
      "• Konstruktor logika i DI inicijalizacija polja",
      "• Web.config — sve vrijednosti konfiguracije i connection stringovi",
      "• Global.asax.cs — Application_Start sekvenca i middleware",
      "• ServicesRegistration.cs — redoslijed DI registracija",
      "• Handler .cs datoteke — ProcessRequest logika",
      "• EasyEdit/XML/*.xml — definicije tipova stranica i polja",
      "• Common/Classes/*.cs — pun kod custom klasa",
      "",
      "Relativne putanje dobiveš iz polja 'keyFiles' u scan rezultatu.",
    ].join("\n"),
    ReadFileSchema.shape,
    async (params) => ({
      content: [{ type: "text", text: await handleReadFile(params) }],
    })
  );
}
