import { Button } from "@/components/ui/button";

import { invoke } from "@/utils/ipc";
import { useState } from "react";
import { Link } from "wouter";
import { columns } from "./update-sources/columns";
import { DataTable } from "./update-sources/data-table";

export const HomePage = () => {
  const [data, setData] = useState([]);

  const handleGetData = async () => {
    const result = await invoke("getUpdateJson");
    setData(result);
  };

  return (
    <div className="w-full space-y-2.5">
      <Link href="/empty-config">Empty Config</Link>

      <Button onClick={() => invoke("push").then(setData)}>PUSH</Button>
      <Button onClick={handleGetData}>GET</Button>
      <DataTable columns={columns} data={data} />
    </div>
  );
};
