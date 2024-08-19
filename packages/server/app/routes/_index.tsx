import {
  type LoaderFunctionArgs,
  type MetaFunction,
  redirect,
} from "@remix-run/node";
import { json, useLoaderData } from "@remix-run/react";

export const meta: MetaFunction = () => {
  return [
    { title: "New Remix App" },
    { name: "description", content: "Welcome to Remix!" },
  ];
};

export function loader({ context }: LoaderFunctionArgs) {
  const { user } = context;
  if (!user) {
    return redirect("/login");
  }
  return json({
    user,
  });
}
export default function Index() {
  const { user } = useLoaderData<typeof loader>();

  return (
    <>
      <h1>Hi, {user.username}!</h1>
      <p>Your user ID is {user.githubId}.</p>
      <form action="/api/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
