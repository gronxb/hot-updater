import logo from "@/assets/logo.png";

export const SplashScreen = () => {
  return (
    <div class="fixed inset-0 flex items-center justify-center bg-white">
      <div class="w-32 h-32 md:w-48 md:h-48 relative">
        <img
          src={logo}
          alt="Hot Updater Console"
          class="w-full h-full object-contain"
        />
      </div>
    </div>
  );
}
