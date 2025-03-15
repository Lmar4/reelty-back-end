import { clerkClient } from "@clerk/express";

export interface UserPayload {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  customClaims?: { [key: string]: any };
}

export async function verifyUserSession(
  sessionId: string
): Promise<UserPayload> {
  try {
    const session = await clerkClient.sessions.getSession(sessionId);
    const user = await clerkClient.users.getUser(session.userId);

    return {
      uid: user.id,
      email: user.emailAddresses[0]?.emailAddress,
      name: `${user.firstName} ${user.lastName}`,
      picture: user.imageUrl,
      customClaims: user.privateMetadata as { [key: string]: any },
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Session verification failed: ${error.message}`);
    }
    throw new Error("Session verification failed");
  }
}

export async function getUserByEmail(email: string): Promise<UserPayload> {
  try {
    const response = await clerkClient.users.getUserList({
      emailAddress: [email],
    });

    const users = response.data;
    if (users.length === 0) {
      throw new Error("User not found");
    }

    const user = users[0];

    return {
      uid: user.id,
      email: user.emailAddresses[0]?.emailAddress,
      name: `${user.firstName} ${user.lastName}`,
      picture: user.imageUrl,
      customClaims: user.privateMetadata as { [key: string]: any },
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`User lookup failed: ${error.message}`);
    }
    throw new Error("User lookup failed");
  }
}

export async function setCustomUserClaims(
  uid: string,
  claims: { [key: string]: any }
): Promise<void> {
  try {
    await clerkClient.users.updateUser(uid, {
      privateMetadata: claims,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Setting custom claims failed: ${error.message}`);
    }
    throw new Error("Setting custom claims failed");
  }
}
