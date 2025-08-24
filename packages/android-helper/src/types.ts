export type AndroidDevice = {
  deviceId: string | undefined;
  readableName: string;
  connected: boolean;
  type: "emulator" | "phone";
};

export type AndroidUser = {
  id: string;
  name: string;
};
