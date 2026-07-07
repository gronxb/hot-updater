import { closeAuthDatabase, getAuth } from "../src/lib/server/auth-factory.server.ts";
import { getAdminBootstrapEnv } from "../src/lib/server/auth-env.server.ts";

const isAlreadyExistsError = (error: unknown) =>
  error instanceof Error &&
  /already exists|already_exists|user_already_exists/i.test(error.message);

const bootstrapAdmin = async () => {
  const adminEnv = getAdminBootstrapEnv();

  try {
    await getAuth().api.createUser({
      body: {
        email: adminEnv.email,
        name: adminEnv.name,
        password: adminEnv.password,
        role: "admin",
      },
    });

    console.log(`Bootstrapped Hot Updater Console admin: ${adminEnv.email}`);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      console.log(`Hot Updater Console admin already exists: ${adminEnv.email}`);
      return;
    }

    throw error;
  } finally {
    await closeAuthDatabase();
  }
};

await bootstrapAdmin();
