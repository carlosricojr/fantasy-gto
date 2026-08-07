"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LeagueForm, type LeagueSettings } from "./league-form";

/**
 * Draft settings, reachable while the draft is running.
 *
 * Everything the setup screen asked for, in the same controls, with the two fields that
 * would re-attribute recorded picks disabled and explained. The previous board offered no
 * way back at all once started: a manager who had picked the wrong scoring format had to
 * clear the tab's storage to escape it.
 *
 * The way out of a genuinely wrong setup is "Start over", which is here, is destructive,
 * and says so before it does anything. Hiding a destructive action is not safety — it just
 * moves the recovery to somewhere the product cannot help with.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
  minRounds,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: LeagueSettings;
  onChange: (patch: Partial<LeagueSettings>) => void;
  minRounds: number;
  onReset: () => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // "Start over" unmounts itself to make room for the confirmation, and a focused element
  // that unmounts drops focus to <body> — so a keyboard user asking to discard a draft was
  // returned to the top of the page instead of to the question. Same failure the status
  // bar's Undo and the queue's arrows guard against; this one needed moving focus rather
  // than keeping the element.
  useEffect(() => {
    if (confirmingReset) confirmRef.current?.focus();
  }, [confirmingReset]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A dialog reopened mid-confirmation would show the destructive state to somebody
        // who came back for something else entirely.
        if (!next) setConfirmingReset(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft settings</DialogTitle>
          <DialogDescription>
            Changes apply immediately. Scoring rebuilds the board, so values and ADP will
            move; the picks you have recorded are kept.
          </DialogDescription>
        </DialogHeader>

        <LeagueForm value={settings} onChange={onChange} inProgress minRounds={minRounds} />

        <DialogFooter className="border-t pt-4 sm:flex-col sm:items-stretch sm:gap-2">
          {confirmingReset ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm font-medium">Discard this draft?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Every recorded pick is removed and the setup screen comes back. This cannot
                be undone.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  ref={confirmRef}
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirmingReset(false);
                    onOpenChange(false);
                    onReset();
                  }}
                >
                  Discard and start over
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
                  Keep drafting
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmingReset(true)}
            >
              Start over
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
