import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";

export const HistoryView = function () {
  const { repoId } = useParams<{ repoId: string }>();
  const searchParams = useSearchParams();
  const commitId = searchParams.get("commit");

  const handleSetAsDefault = async () => {
    const confirmation = confirm(
      "This action will set this historical version as the default version of the project. Are you sure you want to proceed?"
    );
    if (!confirmation) return;
    try {
      const response = await fetch(`/api/projects/${repoId}/${commitId}`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to set default version");
      }
      toast.success("Set as default version successfully!");
      setTimeout(() => {
        close();
      }, 500);
    } catch {
      toast.error("Failed to set as default version, try again later.");
    }
  };

  const close = () => {
    window.location.replace(window.location.pathname);
  };

  return (
    <div className="absolute inset-0 bg-background/10 rounded-2xl backdrop-blur-xs z-10 flex items-center justify-center p-4 border">
      <div className="max-w-sm rounded-2xl overflow-hidden border border-indigo-500/20 bg-card text-center bg-linear-to-b from-accent/50 to-accent/30">
        <header className="bg-linear-to-b from-indigo-500/25 dark:from-indigo-500/40 to-accent p-6">
          <div className="flex items-center justify-center -space-x-4 mb-3">
            <div className="size-9 rounded-full bg-pink-200 shadow-2xs flex items-center justify-center text-xl opacity-50">
              ✏️
            </div>
            <div className="size-11 rounded-full bg-amber-200 shadow-2xl flex items-center justify-center text-2xl z-2">
              👀
            </div>
            <div className="size-9 rounded-full bg-sky-200 shadow-2xs flex items-center justify-center text-xl opacity-50">
              🔒
            </div>
          </div>
          <p className="text-xl font-semibold text-primary">
            History View Enabled
          </p>
          <p className="text-sm text-muted-foreground mt-1.5">
            You are currently viewing a historical version of this project.
            Editing is disabled in this mode.
          </p>
        </header>
        <div className="p-5 bg-accent flex items-center justify-center gap-2">
          <Button
            variant="transparent"
            size="sm"
            className="flex-1 cyrsor"
            onClick={() => close()}
          >
            <ArrowLeft className="" />
            Go Back
          </Button>
          <Button
            variant="default"
            size="sm"
            className="flex-1"
            onClick={handleSetAsDefault}
          >
            Set as Default Version
          </Button>
        </div>
      </div>
    </div>
  );
};
