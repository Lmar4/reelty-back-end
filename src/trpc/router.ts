import { router } from "./types";
import { userRouter } from "./routes/user";
import { propertyRouter } from "./routes/property";
import { jobsRouter } from "./routes/jobs";
import { subscriptionRouter } from "./routes/subscriptions";
import { adminRouter } from "./routes/admin";
import { storageRouter } from "./routes/storage";

export const appRouter = router({
  user: userRouter,
  property: propertyRouter,
  jobs: jobsRouter,
  subscription: subscriptionRouter,
  admin: adminRouter,
  storage: storageRouter,
});

export type AppRouter = typeof appRouter;
