import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export const EmptyConfigPage = () => {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-lg font-bold">No configuration found</div>
      <div className="text-sm text-gray-500">
        Please create a new configuration or import an existing one.
      </div>

      <Button asChild className="mt-4">
        <Link href="/">Go Home</Link>
      </Button>
    </div>
  );
};
