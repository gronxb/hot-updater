import crypto from "crypto";
import { Box, Text } from "ink";
import { useMemo } from "react";

export default function GenerateSecretKey() {
  const secretKey = useMemo(() => crypto.randomBytes(32).toString("hex"), []);

  return (
    <Box flexDirection="column">
      <Text color="green">Secret Key: </Text>
      <Text>{secretKey}</Text>
    </Box>
  );
}
