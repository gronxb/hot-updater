import { Title } from "@solidjs/meta";
import { createAsync } from "@solidjs/router";
import { api } from "~/lib/api";

export default function Home() {
  const hello = createAsync(() => api.hotUpdater.hello.query("world"));
  return (
    <main>
      <Title>Hello World</Title>
    </main>
  );
}
