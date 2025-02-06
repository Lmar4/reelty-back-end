import { getTRPC } from "./types";
import { getUserRouter } from "./routes/user";
import { getPropertyRouter } from "./routes/property";
import { getJobsRouter } from "./routes/jobs";
import { getSubscriptionRouter } from "./routes/subscriptions";
import { getAdminPanelRouter } from "./routes/admin";
import { getStorageRouter } from "./routes/storage";

// Initialize the router asynchronously
const initializeRouter = async () => {
  const { router } = await getTRPC();
  const [
    userRoutes,
    propertyRoutes,
    jobsRoutes,
    subscriptionRoutes,
    adminPanelRoutes,
    storageRoutes,
  ] = await Promise.all([
    getUserRouter(),
    getPropertyRouter(),
    getJobsRouter(),
    getSubscriptionRouter(),
    getAdminPanelRouter(),
    getStorageRouter(),
  ]);

  return router({
    user: userRoutes,
    property: propertyRoutes,
    jobs: jobsRoutes,
    subscription: subscriptionRoutes,
    adminPanel: adminPanelRoutes,
    storage: storageRoutes,
  });
};

export const getAppRouter = async () => {
  return await initializeRouter();
};

// This type will be used by the client
export type AppRouter = Awaited<ReturnType<typeof getAppRouter>>;
