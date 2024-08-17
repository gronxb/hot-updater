import { version } from "@/packageJson.js";
import { Box, Text } from "ink";
import Link from "ink-link";

export const Banner = () => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      alignSelf="flex-start"
    >
      <Text>Hot Updater - React Native OTA Solution v{version}</Text>
      <Box justifyContent="center">
        <Link url="https://github.com/gronxb/hot-updater">
          <Text color="cyan">Github</Text>
        </Link>
      </Box>
    </Box>
  );
};
