export const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return Number(`${year}${month}${day}${hours}${minutes}${seconds}`);
};
export function formatDateTimeFromBundleVersion(input) {
    const year = input.substring(0, 4);
    const month = input.substring(4, 6);
    const day = input.substring(6, 8);
    const hour = input.substring(8, 10);
    const minute = input.substring(10, 12);
    const second = input.substring(12, 14);
    return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
}
