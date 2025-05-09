import Testing

struct TempTest {
    // Since React Native doesn't support SPM yet, we can't build properly. Will add proper unit tests when it's officially supported
    @Test
    func testAddition() {
        #expect(1 + 1 == 2)
    }
}