import time
from rpi_ws281x import PixelStrip, Color

LED_COUNT = 4
LED_PIN = 13
LED_FREQ_HZ = 800000
LED_DMA = 10
LED_BRIGHTNESS = 100
LED_INVERT = False
LED_CHANNEL = 1

strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
strip.begin()

print("Setting all LEDs GREEN")
for i in range(LED_COUNT):
    strip.setPixelColor(i, Color(0, 255, 0))
strip.show()
time.sleep(3)

print("Setting all LEDs RED")
for i in range(LED_COUNT):
    strip.setPixelColor(i, Color(255, 0, 0))
strip.show()
time.sleep(3)

print("Turning off")
for i in range(LED_COUNT):
    strip.setPixelColor(i, Color(0, 0, 0))
strip.show()
