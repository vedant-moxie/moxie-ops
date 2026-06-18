"use client";

import {
  Bar, BarChart, Area, AreaChart, Line, LineChart, Pie, PieChart, Cell,
  ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LIME = "#a3d83b";
const MINT = "#7fd9b8";
const INK = "#1a1a1a";
const AMBER = "#f59e0b";
const RED = "#ef4444";
const SUCCESS = "#10b981";

const axis = { fontSize: 11, fill: "#9a958a" };
const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid #e7e2d4",
  fontSize: 12,
  boxShadow: "0 12px 32px -16px rgba(0,0,0,.2)",
};

function shortDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export interface KpiData {
  fillRateByChannel: { channel: string; gross: number; net: number | null }[];
  fillRateTrend: { date: string; gross: number | null }[];
  dispatchTat: { date: string; hours: number | null }[];
  grnAcceptance: { name: string; value: number }[];
  orderVolume: { date: string; count: number }[];
}

export function AnalyticsCharts({ data }: { data: KpiData }) {
  const donutColors = [SUCCESS, RED, "#7c6df0"];

  const hasChannelFill = data.fillRateByChannel.length > 0;
  const hasFillTrend = data.fillRateTrend.some((d) => d.gross != null);
  const hasTat = data.dispatchTat.some((d) => d.hours != null);
  const hasGrn = data.grnAcceptance.some((g) => g.value > 0);
  const hasVolume = data.orderVolume.some((d) => d.count > 0);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Fill rate by channel · gross vs net</CardTitle></CardHeader>
        <CardContent>
          {!hasChannelFill ? (
            <ChartEmpty message="No delivered POs in the last 30 days." />
          ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.fillRateByChannel} margin={{ left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
              <XAxis dataKey="channel" tick={axis} axisLine={false} tickLine={false} />
              <YAxis tick={axis} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) => [v == null ? "—" : `${v}%`, name === "gross" ? "Gross" : "Net"]}
                cursor={{ fill: "#f5f1e6" }}
              />
              <Bar name="Gross" dataKey="gross" fill={LIME} radius={[8, 8, 0, 0]} maxBarSize={36} />
              <Bar name="Net" dataKey="net" fill={INK} radius={[8, 8, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
          )}
          <div className="mt-2 flex justify-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: LIME }} /> Gross (delivered ÷ ordered)</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: INK }} /> Net (delivered ÷ assigned)</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Gross fill-rate trend (30 days)</CardTitle></CardHeader>
        <CardContent>
          {!hasFillTrend ? (
            <ChartEmpty message="No GRNs received in the last 30 days." />
          ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.fillRateTrend} margin={{ left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis tick={axis} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={shortDate} formatter={(v) => [v == null ? "—" : `${v}%`, "Gross fill"]} />
              <Line type="monotone" dataKey="gross" stroke={SUCCESS} strokeWidth={2.5} dot={{ r: 2, fill: SUCCESS }} activeDot={{ r: 5 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Dispatch TAT · approval → dispatch/receipt</CardTitle></CardHeader>
        <CardContent>
          {!hasTat ? (
            <ChartEmpty message="No approved POs with a dispatch or GRN event in the last 30 days." />
          ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.dispatchTat} margin={{ left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis tick={axis} axisLine={false} tickLine={false} unit="h" />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={shortDate} formatter={(v) => [v == null ? "—" : `${v}h`, "Avg TAT"]} />
              <Line type="monotone" dataKey="hours" stroke={INK} strokeWidth={2.5} dot={{ r: 3, fill: LIME }} activeDot={{ r: 5 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">GRN acceptance</CardTitle></CardHeader>
        <CardContent>
          {!hasGrn ? (
            <ChartEmpty message="No GRNs received in the last 30 days." />
          ) : (
          <>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={data.grnAcceptance}
                dataKey="value"
                nameKey="name"
                innerRadius={62}
                outerRadius={96}
                paddingAngle={2}
              >
                {data.grnAcceptance.map((_, i) => (
                  <Cell key={i} fill={donutColors[i % donutColors.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-2 flex flex-wrap justify-center gap-4">
            {data.grnAcceptance.map((g, i) => (
              <span key={g.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: donutColors[i % donutColors.length] }} />
                {g.name} ({g.value})
              </span>
            ))}
          </div>
          </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Order volume (30 days)</CardTitle></CardHeader>
        <CardContent>
          {!hasVolume ? (
            <ChartEmpty message="No POs ingested in the last 30 days." />
          ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data.orderVolume} margin={{ left: -16 }}>
              <defs>
                <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={MINT} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={MINT} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee7d6" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={axis} axisLine={false} tickLine={false} minTickGap={28} />
              <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={shortDate} formatter={(v) => [v, "POs"]} />
              <Area type="monotone" dataKey="count" stroke={MINT} strokeWidth={2} fill="url(#vol)" />
            </AreaChart>
          </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
