// The app's only channel to the wallet: messages to the extension background, which holds every
// secret and makes every decision. The app renders what it is given and reports the user's choice.

export interface ConnectPrompt {
  origin: string;
  slots: number[];
  methods: string[];
}

type Response<T> = { ok: true; result: T } | { ok: false; error: { code: number; message: string } };

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

export const getApproval = (id: string) => send<ConnectPrompt | null>({ kind: "approval.get", id });

export const resolveApproval = (id: string, approved: boolean) =>
  send<null>({ kind: "approval.resolve", id, approved });
