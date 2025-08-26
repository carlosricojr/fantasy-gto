import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Paywall({ entitlement, expectedValue }: { entitlement: string; expectedValue: string }) {
  return (
    <div className="rounded-lg border border-foreground/15 p-4">
      <p className="text-sm">Unlock <span className="font-medium">{entitlement}</span> to gain approximately {expectedValue}.</p>
      <div className="mt-3">
        <Link href="/pricing"><Button>See plans</Button></Link>
      </div>
    </div>
  );
}


