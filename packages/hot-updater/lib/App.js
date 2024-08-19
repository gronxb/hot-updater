// import type { Platform } from "@hot-updater/internal";
// import { Box, Text, useInput } from "ink";
// import Link from "ink-link";
// import { useState } from "react";
// import { FullScreen } from "./components/FullScreen";
export {};
// interface Props {
//   platform?: Platform;
//   targetVersion?: string;
//   forceUpdate?: boolean;
// }
// interface PaginationProps {
//   totalItems: number;
//   itemsPerPage: number;
// }
// const users = Array.from({ length: 10 })
//   .fill(true)
//   .map((_, index) => ({
//     id: index + 10,
//   }));
// const Pagination: React.FC<PaginationProps> = ({
//   totalItems,
//   itemsPerPage,
// }) => {
//   const [currentPage, setCurrentPage] = useState(1);
//   const totalPages = Math.ceil(totalItems / itemsPerPage);
//   useInput((_, key) => {
//     if (key.leftArrow && currentPage > 1) {
//       setCurrentPage(currentPage - 1);
//     } else if (key.rightArrow && currentPage < totalPages) {
//       setCurrentPage(currentPage + 1);
//     }
//   });
//   return (
//     <Box flexDirection="column">
//       <Box>
//         <Text>{users[currentPage]?.id}</Text>
//       </Box>
//       <Box>
//         <Text>
//           Page {currentPage} of {totalPages}
//         </Text>
//       </Box>
//       <Box>
//         <Text>[Use left/right arrows to navigate]</Text>
//       </Box>
//     </Box>
//   );
// };
// export function App({ forceUpdate, platform, targetVersion }: Props) {
//   const totalItems = 100;
//   const itemsPerPage = 10;
//   return (
//     <FullScreen flexDirection="column">
//       <Box
//         flexDirection="column"
//         borderStyle="round"
//         borderColor="cyan"
//         alignSelf="flex-start"
//       >
//         <Text>
//           Hot Updater v{process.env["VERSION"]} - React Native OTA Solution
//         </Text>
//         <Box justifyContent="center">
//           <Link url="https://github.com/gronxb/hot-updater">
//             <Text color="cyan">Github</Text>
//           </Link>
//         </Box>
//       </Box>
//       <Text>Ink CLI Pagination Example</Text>
//       <Pagination totalItems={totalItems} itemsPerPage={itemsPerPage} />
//     </FullScreen>
//   );
// }
