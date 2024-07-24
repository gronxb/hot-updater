import { Box, Text } from "ink";

import { Badge } from "@inkjs/ui";

type Props = {
  name: string | undefined;
};

export function App({ name = "Stranger" }: Props) {
  return (
    <Box>
      <Badge color="green">Hello</Badge>
      <Badge color="blue">World</Badge>
      <Text>
        Hello2, <Text color="green">{name}</Text>
      </Text>
    </Box>
  );
}
