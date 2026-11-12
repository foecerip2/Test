import { AuthScreen } from "@/components/AuthScreen";
export const metadata = {
  title: "Регистрация — AutoFlow",
  robots: { index: false, follow: false },
};
export default function Register() {
  return <AuthScreen register />;
}
