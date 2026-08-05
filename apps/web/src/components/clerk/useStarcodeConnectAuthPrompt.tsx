import { useClerk } from "@clerk/react";

export function useStarcodeConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openWaitlist();
  };
  return { authPrompt: null, openAuthPrompt };
}
