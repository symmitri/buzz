// Symmitri modification: Spaces labels for the Alpha build.
import { PRODUCT_NAME } from "@/shared/lib/product-brand";
import { RecoveryScreen } from "./RecoveryScreen";

export function ResetFailedScreen() {
  return (
    <RecoveryScreen
      testId="reset-failed"
      title="Sign out could not complete"
      body={`${PRODUCT_NAME} was unable to fully clear your local data. Try relaunching — the reset will resume automatically. If this persists, contact support.`}
    />
  );
}
