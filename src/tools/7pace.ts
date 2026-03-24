// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { z } from "zod";

// ─── Konstante ────────────────────────────────────────────────────────────────

const SEVENP_TOOLS = {
  log_time: "7pace_log_time",
  log_time_distributed: "7pace_log_time_distributed",
  get_logged_time: "7pace_get_logged_time",
  delete_time_log: "7pace_delete_time_log",
};

const SEVENP_API_VERSION = "3.2";

// Activity types konfigurirani u 7pace Timetrackeru
const ACTIVITY_TYPES = [
  "[Not Set]",
  "Administration",
  "Billable Development",
  "Billable Requirements",
  "Billable Slicing",
  "Billable Support",
  "Design",
  "Development",
  "Process",
  "Requirements",
  "Sales",
  "Sales requirements",
  "Slicing",
  "Support",
  "Testing",
] as const;

type ActivityType = (typeof ACTIVITY_TYPES)[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

// Lokalni ISO datetime bez timezone — 7pace on-prem očekuje "2024-03-15T00:00:00"
function toTimestamp(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(d.getTime())) {
    throw new Error(`Neispravan datum: "${dateStr}". Koristi format YYYY-MM-DD.`);
  }
  d.setHours(0, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00`;
}

// Isti auth header pattern kao u workitems.ts
function buildAuthHeader(accessToken: string): string {
  const isBasicAuth = process.env["ADO_MCP_AUTH_TYPE"] === "basic";
  return isBasicAuth ? `Basic ${Buffer.from(":" + accessToken).toString("base64")}` : `Bearer ${accessToken}`;
}

// Izvuci 7pace API base URL iz postojeće ADO konekcije — bez dodatnih parametara.
// serverUrl je npr. "http://tfsmoon.wem.local:8080/tfs/New"
// Collection name je zadnji segment patha (npr. "New").
// 7pace je na portu 8090 istog hosta: "http://tfsmoon.wem.local:8090/api/New/rest"
// Override moguć kroz ADO_7PACE_URL env varijablu (samo host+port, bez patha).
function get7paceApiBase(connection: WebApi): string {
  const serverUrl = connection.serverUrl.replace(/\/$/, "");
  const collection = serverUrl.split("/").pop() ?? "DefaultCollection";

  if (process.env["ADO_7PACE_URL"]) {
    return `${process.env["ADO_7PACE_URL"].replace(/\/$/, "")}/api/${collection}/rest`;
  }

  const url = new URL(serverUrl);
  url.port = "8090";
  url.pathname = "";
  return `${url.origin}/api/${collection}/rest`;
}

async function sevenPaceFetch(
  method: "GET" | "POST" | "DELETE",
  apiBase: string,
  path: string,
  authHeader: string,
  userAgent: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; statusText: string; data: unknown }> {
  const url = `${apiBase}/${path}?api-version=${SEVENP_API_VERSION}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": userAgent,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let data: unknown;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, statusText: response.statusText, data };
}

// Dohvati ID activity typea po imenu — 7pace API prima ID, ne ime
async function resolveActivityTypeId(activityType: ActivityType | undefined, apiBase: string, authHeader: string, userAgent: string): Promise<string | undefined> {
  if (!activityType || activityType === "[Not Set]") return undefined;

  const res = await sevenPaceFetch("GET", apiBase, "activityTypes", authHeader, userAgent);
  if (!res.ok) {
    throw new Error(`Ne mogu dohvatiti activity types: HTTP ${res.status} ${res.statusText}`);
  }

  const body = res.data as { data?: Array<{ id: string; name: string }> };
  const match = body.data?.find((at) => at.name.toLowerCase() === activityType.toLowerCase());

  if (!match) {
    throw new Error(`Activity type "${activityType}" nije pronađen. Dostupni: ${body.data?.map((a) => a.name).join(", ")}`);
  }

  return match.id;
}

// ─── Tool konfiguracija ───────────────────────────────────────────────────────

function configure7paceTools(server: McpServer, tokenProvider: () => Promise<string>, connectionProvider: () => Promise<WebApi>, userAgentProvider: () => string) {
  // ── 1. log_time ──────────────────────────────────────────────────────────────
  server.tool(
    SEVENP_TOOLS.log_time,
    "Upiši sate rada na određeni ADO task u 7pace Timetracker. " + "Primjer: 'zapiši na task 12345 3 sata developmenta'.",
    {
      workItemId: z.number().describe("ID work itema (taska) na koji se upisuju sati."),
      hours: z.number().positive().describe("Broj sati za upisati. Decimalni unos podržan (npr. 1.5 = sat i pol)."),
      activityType: z
        .enum(ACTIVITY_TYPES)
        .optional()
        .describe("Vrsta aktivnosti. Ako nije navedeno, koristi se '[Not Set]'. " + "Dostupne vrijednosti: " + ACTIVITY_TYPES.filter((a) => a !== "[Not Set]").join(", ") + "."),
      date: z.string().optional().describe("Datum rada u formatu YYYY-MM-DD. Defaultno: danas."),
      comment: z.string().optional().describe("Opcionalni komentar / opis obavljenog rada."),
    },
    async ({ workItemId, hours, activityType, date, comment }) => {
      try {
        const [connection, accessToken] = await Promise.all([connectionProvider(), tokenProvider()]);
        const apiBase = get7paceApiBase(connection);
        const authHeader = buildAuthHeader(accessToken);

        const activityTypeId = await resolveActivityTypeId(activityType, apiBase, authHeader, userAgentProvider());

        const body: Record<string, unknown> = {
          workItemId,
          length: hoursToSeconds(hours),
          timestamp: toTimestamp(date),
        };
        if (activityTypeId) body.activityTypeId = activityTypeId;
        if (comment) body.comment = comment;

        const res = await sevenPaceFetch("POST", apiBase, "workLogs", authHeader, userAgentProvider(), body);

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Greška pri upisivanju sati: HTTP ${res.status} ${res.statusText}\n${JSON.stringify(res.data, null, 2)}` }],
            isError: true,
          };
        }

        const logData = res.data as { data?: { id?: string } };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  workItemId,
                  hours,
                  activityType: activityType ?? "[Not Set]",
                  date: toTimestamp(date),
                  logId: logData?.data?.id ?? null,
                  comment: comment ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Greška pri upisivanju sati: ${error instanceof Error ? error.message : "Nepoznata greška"}` }],
          isError: true,
        };
      }
    }
  );

  // ── 2. log_time_distributed ──────────────────────────────────────────────────
  server.tool(
    SEVENP_TOOLS.log_time_distributed,
    "Rasporedi ukupan broj sati ravnomjerno na više ADO taskova i upiši ih u 7pace Timetracker. " +
      "Primjer: 'danas sam radio na taskovima 12340, 12341, 12342, ukupno 6 sati developmenta, rasporedi ravnomjerno'.",
    {
      workItemIds: z.array(z.number()).min(1).describe("Lista ID-eva work itema na koje se raspoređuju sati."),
      totalHours: z.number().positive().describe("Ukupan broj sati koji se dijeli ravnomjerno na sve taskove."),
      activityType: z
        .enum(ACTIVITY_TYPES)
        .optional()
        .describe("Vrsta aktivnosti koja se primjenjuje na sve upisane stavke. " + "Dostupne vrijednosti: " + ACTIVITY_TYPES.filter((a) => a !== "[Not Set]").join(", ") + "."),
      date: z.string().optional().describe("Datum rada u formatu YYYY-MM-DD. Defaultno: danas."),
      comment: z.string().optional().describe("Opcionalni komentar koji se dodaje na sve stavke."),
    },
    async ({ workItemIds, totalHours, activityType, date, comment }) => {
      try {
        const [connection, accessToken] = await Promise.all([connectionProvider(), tokenProvider()]);
        const apiBase = get7paceApiBase(connection);
        const authHeader = buildAuthHeader(accessToken);

        const activityTypeId = await resolveActivityTypeId(activityType, apiBase, authHeader, userAgentProvider());
        const hoursPerTask = totalHours / workItemIds.length;
        const secondsPerTask = hoursToSeconds(hoursPerTask);
        const timestamp = toTimestamp(date);

        const results: Array<{
          workItemId: number;
          hours: number;
          success: boolean;
          logId?: string;
          error?: string;
        }> = [];

        for (const workItemId of workItemIds) {
          try {
            const body: Record<string, unknown> = { workItemId, length: secondsPerTask, timestamp };
            if (activityTypeId) body.activityTypeId = activityTypeId;
            if (comment) body.comment = comment;

            const res = await sevenPaceFetch("POST", apiBase, "workLogs", authHeader, userAgentProvider(), body);

            if (!res.ok) {
              results.push({ workItemId, hours: hoursPerTask, success: false, error: `HTTP ${res.status} ${res.statusText}` });
            } else {
              const logData = res.data as { data?: { id?: string } };
              results.push({ workItemId, hours: hoursPerTask, success: true, logId: logData?.data?.id ?? undefined });
            }
          } catch (error) {
            results.push({
              workItemId,
              hours: hoursPerTask,
              success: false,
              error: error instanceof Error ? error.message : "Nepoznata greška",
            });
          }
        }

        const successCount = results.filter((r) => r.success).length;
        const failCount = results.length - successCount;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: {
                    totalHours,
                    hoursPerTask: Math.round(hoursPerTask * 100) / 100,
                    activityType: activityType ?? "[Not Set]",
                    tasksTotal: workItemIds.length,
                    tasksSuccess: successCount,
                    tasksFailed: failCount,
                    date: timestamp,
                  },
                  results,
                },
                null,
                2
              ),
            },
          ],
          isError: failCount > 0 && successCount === 0,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Greška pri raspoređivanju sati: ${error instanceof Error ? error.message : "Nepoznata greška"}` }],
          isError: true,
        };
      }
    }
  );

  // ── 3. get_logged_time ───────────────────────────────────────────────────────
  server.tool(
    SEVENP_TOOLS.get_logged_time,
    "Dohvati upisane sate iz 7pace Timetrackera. Može filtrirati po work itemu i/ili datumu.",
    {
      workItemId: z.number().optional().describe("Opcionalni ID work itema. Ako nije naveden, vraća logove trenutnog korisnika."),
      date: z.string().optional().describe("Točan datum u formatu YYYY-MM-DD."),
      dateFrom: z.string().optional().describe("Početni datum raspona (YYYY-MM-DD)."),
      dateTo: z.string().optional().describe("Završni datum raspona (YYYY-MM-DD)."),
      top: z.number().optional().default(50).describe("Maksimalni broj rezultata. Defaultno 50."),
    },
    async ({ workItemId, date, dateFrom, dateTo, top }) => {
      try {
        const [connection, accessToken] = await Promise.all([connectionProvider(), tokenProvider()]);
        const apiBase = get7paceApiBase(connection);
        const authHeader = buildAuthHeader(accessToken);

        const params: string[] = [`api-version=${SEVENP_API_VERSION}`, `$count=${top}`];

        if (workItemId) params.push(`$workItemIds=${workItemId}`);

        if (date && !dateFrom && !dateTo) {
          const d = new Date(toTimestamp(date));
          const next = new Date(d);
          next.setDate(next.getDate() + 1);
          const pad = (n: number) => String(n).padStart(2, "0");
          params.push(`$fromTimestamp=${toTimestamp(date)}`);
          params.push(`$toTimestamp=${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T00:00:00`);
        } else {
          if (dateFrom) params.push(`$fromTimestamp=${toTimestamp(dateFrom)}`);
          if (dateTo) params.push(`$toTimestamp=${toTimestamp(dateTo)}`);
        }

        const url = `${apiBase}/workLogs?${params.join("&")}`;
        const response = await fetch(url, {
          headers: {
            "Authorization": authHeader,
            "Accept": "application/json",
            "User-Agent": userAgentProvider(),
          },
        });

        let data: unknown;
        try {
          data = response.ok ? await response.json() : await response.text();
        } catch {
          data = null;
        }

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Greška pri dohvatu logova: HTTP ${response.status} ${response.statusText}\n${JSON.stringify(data, null, 2)}` }],
            isError: true,
          };
        }

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Greška pri dohvatu logova: ${error instanceof Error ? error.message : "Nepoznata greška"}` }],
          isError: true,
        };
      }
    }
  );

  // ── 4. delete_time_log ───────────────────────────────────────────────────────
  server.tool(
    SEVENP_TOOLS.delete_time_log,
    "Obriši postojeći unos sati iz 7pace Timetrackera po ID-u loga.",
    {
      logId: z.string().describe("ID unosa sati koji se briše (GUID, dohvatljiv iz get_logged_time)."),
    },
    async ({ logId }) => {
      try {
        const [connection, accessToken] = await Promise.all([connectionProvider(), tokenProvider()]);
        const apiBase = get7paceApiBase(connection);
        const authHeader = buildAuthHeader(accessToken);

        const res = await sevenPaceFetch("DELETE", apiBase, `workLogs/${logId}`, authHeader, userAgentProvider());

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Greška pri brisanju loga: HTTP ${res.status} ${res.statusText}\n${JSON.stringify(res.data, null, 2)}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, deletedLogId: logId }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Greška pri brisanju loga: ${error instanceof Error ? error.message : "Nepoznata greška"}` }],
          isError: true,
        };
      }
    }
  );
}

export { SEVENP_TOOLS, configure7paceTools };
