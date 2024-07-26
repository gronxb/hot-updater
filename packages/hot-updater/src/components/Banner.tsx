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
      <Text>
        Hot Updater v{process.env["VERSION"]} - React Native OTA Solution
      </Text>
      <Box justifyContent="center">
        <Link url="https://github.com/gronxb/hot-updater">
          <Text color="cyan">Github</Text>
        </Link>
      </Box>
    </Box>
  );
};
