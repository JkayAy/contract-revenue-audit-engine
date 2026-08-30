"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertOctagon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AnomaliesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center gap-4 p-12 text-center">
      <AlertOctagon className="h-10 w-10 text-destructive" aria-hidden="true" />
      <h2 className="text-xl font-semibold text-foreground">
        Something went wrong loading the audit dashboard
      </h2>
      <p className="text-sm text-muted-foreground">
        {error.message || "An unexpected error occurred while loading anomalies."}
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">Error reference: {error.digest}</p>
      )}
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
