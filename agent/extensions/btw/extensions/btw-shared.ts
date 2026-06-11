import { type AssistantMessage, type ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";

export type SessionThinkingLevel = "off" | AiThinkingLevel;

export type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

export function extractAssistantText(message: AssistantMessage): string {
  return extractText(message.content, "text");
}

export function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}
