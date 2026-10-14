import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export interface WidgetStyle {
  accent(text: string): string;
  muted(text: string): string;
  fit(text: string, width: number): string;
  width(text: string): number;
}
export const widgetStyle = (theme: Theme): WidgetStyle => ({
  accent: (text) => theme.fg("accent", text),
  muted: (text) => theme.fg("dim", text),
  fit: truncateToWidth,
  width: visibleWidth,
});
export const singleLine = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const workingLabel = (now = Date.now(), label = "Working") =>
  `${frames[Math.floor(now / 100) % frames.length]} ${label}`;
