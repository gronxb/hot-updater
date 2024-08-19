import { Button } from "@/components/ui/button";
import { type LoaderFunctionArgs, redirect } from "@remix-run/node";

export function loader({ context }: LoaderFunctionArgs) {
  if (context.user) {
    return redirect("/");
  }
  return null;
}

export default function LoginPage() {
  return (
    <>
      <Button asChild>
        <a href="/api/login/github">Sign in with GitHub</a>
      </Button>
    </>
  );
}
