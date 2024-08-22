import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export const Sidebar = ({ onClose, open }: SidebarProps) => {
  return (
    <aside
      className={cn(
        "fixed right-0 z-50 flex-col hidden min-w-64 h-full gap-4 p-4 sm:flex bg-muted ease-in-out duration-300 shadow-lg",
        open ? "translate-x-0" : "translate-x-full",
      )}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <X
        className={cn("fixed w-5 h-5 cursor-pointer top-4 right-4")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      <div className="font-medium">Edit</div>

      <div>
        <label htmlFor="targetVersion">Target Version</label>
        <Input id="targetVersion" value="13.2" />
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <Textarea id="description" placeholder="hi" />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox id="forceUpdate">Force Update</Checkbox>
          <label htmlFor="forceUpdate">Force Update</label>
        </div>
        <p className="text-xs text-gray-500">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>

        <div className="flex items-center gap-2">
          <Checkbox id="enabled" defaultChecked>
            Enabled
          </Checkbox>
          <label htmlFor="enabled">Enabled</label>
        </div>
        <p className="text-xs text-gray-500">
          When disabled, this update will not be available to your users.
        </p>
        <Button className="mt-6">Save</Button>
      </div>
    </aside>
  );
};
