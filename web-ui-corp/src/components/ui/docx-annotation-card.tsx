import * as React from "react"
import type {
  DocxCommentCardRenderProps,
  DocxTrackedChangeCardRenderProps,
} from "@extend-ai/react-docx"

import { Badge } from "./badge"
import { Card } from "./card"

function trackedChangeBadgeVariant(
  kind: DocxTrackedChangeCardRenderProps["change"]["kind"]
): React.ComponentProps<typeof Badge>["variant"] {
  switch (kind) {
    case "insertion":
    case "move-to":
      return "default"
    case "deletion":
    case "move-from":
      return "destructive"
    default:
      return "destructive"
  }
}

function trackedChangeBadgeLabel({
  change,
  kindLabel,
}: Pick<DocxTrackedChangeCardRenderProps, "change" | "kindLabel">) {
  switch (change.kind) {
    case "insertion":
      return "Inserted"
    case "deletion":
      return "Removed"
    case "move-from":
      return "Moved from"
    case "move-to":
      return "Moved to"
    default:
      return kindLabel
  }
}

function DocxAnnotationCard({
  anchorText,
  badge,
  badgeVariant = "outline",
  date,
  meta,
  snippet,
  style,
}: {
  anchorText?: string
  badge: string
  badgeVariant?: React.ComponentProps<typeof Badge>["variant"]
  date?: string
  meta: string
  snippet: string
  style: React.CSSProperties
}) {
  return (
    <Card
      style={style}
      className="pointer-events-auto box-border gap-2 rounded-lg bg-card/95 p-2 text-card-foreground shadow-sm before:rounded-[7px]"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 text-[11px] leading-tight font-medium text-muted-foreground">
          <div className="truncate">{meta}</div>
          {date ? <div className="mt-0.5 truncate">{date}</div> : null}
        </div>
        <Badge
          variant={badgeVariant}
          
          className="max-w-[92px] truncate"
        >
          {badge}
        </Badge>
      </div>
      {anchorText ? (
        <div className="rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-snug text-muted-foreground italic">
          {anchorText}
        </div>
      ) : null}
      <div className="text-xs leading-snug break-words">{snippet}</div>
    </Card>
  )
}

export function renderDocxTrackedChangeCard({
  change,
  formattedDate,
  kindLabel,
  snippet,
  style,
}: DocxTrackedChangeCardRenderProps) {
  return (
    <DocxAnnotationCard
      badge={trackedChangeBadgeLabel({ change, kindLabel })}
      badgeVariant={trackedChangeBadgeVariant(change.kind)}
      date={formattedDate}
      meta={change.author?.trim() || "Unknown author"}
      snippet={snippet}
      style={style}
    />
  )
}

export function renderDocxCommentCard({
  comment,
  formattedDate,
  snippet,
  style,
}: DocxCommentCardRenderProps) {
  const badge = comment.resolved
    ? "Resolved"
    : comment.parentId !== undefined
      ? "Reply"
      : "Comment"

  return (
    <DocxAnnotationCard
      anchorText={comment.anchorText}
      badge={badge}
      badgeVariant={comment.resolved ? "secondary" : "default"}
      date={formattedDate}
      meta={comment.author?.trim() || "Unknown author"}
      snippet={snippet}
      style={style}
    />
  )
}
