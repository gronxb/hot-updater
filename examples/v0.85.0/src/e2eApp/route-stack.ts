import { createNativeStackNavigator } from "@react-navigation/native-stack";

import type { RootStackParamList } from "./types";

export const Stack = createNativeStackNavigator<RootStackParamList>();
