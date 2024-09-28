import { Button } from "@/components/ui/button";
import { createSignal } from "solid-js";
import "./app.css";

const App = () => {
  const [count, setCount] = createSignal(0);

  return (
    <div class="content">
      <h1>Rsbuild with Solid</h1>
      <Button onClick={() => setCount(count() + 1)}>Count: {count()}</Button>
    </div>
  );
};

export default App;
