import { cn } from "@/lib/utils";
import type { UpdateSource } from "@hot-updater/plugin-core";
import { Form, useSubmit } from "@remix-run/react";
import { ActionFunctionArgs, redirect } from "@remix-run/server-runtime";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
  source: UpdateSource;
}

export const Sidebar = ({ source, onClose, open }: SidebarProps) => {
  const [targetVersion, setTargetVersion] = useState(source.targetVersion);
  const [description, setDescription] = useState(source.description);
  const [forceUpdate, setForceUpdate] = useState(source.forceUpdate);
  const [enabled, setEnabled] = useState(source.enabled);
  
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
       <Form  method="post">
      <X
        className={cn("fixed w-5 h-5 cursor-pointer top-4 right-4")}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
       <input type="hidden" name="bundleVersion" value={source.bundleVersion} />
       
      <div className="font-medium">Edit</div>

      <div>
        <label htmlFor="targetVersion">Target Version</label>
        <Input id="targetVersion" name="targetVersion" value={targetVersion} 
        onChange={(e) => setTargetVersion(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="description">Description</label>
        <Textarea id="description" placeholder="hi" name="description"
        value={description} onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox id="forceUpdate" name="forceUpdate"
          checked={forceUpdate} onCheckedChange={(e) => typeof e === "boolean" && setForceUpdate(e)}
          >Force Update</Checkbox>
          <label htmlFor="forceUpdate">Force Update</label>
        </div>
        <p className="text-xs text-gray-500">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>

        <div className="flex items-center gap-2">
          <Checkbox id="enabled" name="enabled"
          checked={enabled} onCheckedChange={(e) => typeof e === "boolean" && setEnabled(e)}
          >
            Enabled
          </Checkbox>
          <label htmlFor="enabled">Enabled</label>
        </div>
        <p className="text-xs text-gray-500">
          When disabled, this update will not be available to your users.
        </p>
        <Button className="mt-6" type="submit">Save</Button>
      </div>
      </Form>
    </aside>
  );
};
