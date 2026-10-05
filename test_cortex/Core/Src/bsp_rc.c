/**
 * bsp_rc: remote control (SBUS over USART2) thin wrapper.
 *   - Assembly only; the generic DMA/IDLE receive layer is bsp_usart.
 *   - The frame parser is registered by remote_control through
 *     bsp_uart_dma_rx_register_cb().
 */
#include "bsp_rc.h"
#include "bsp_usart.h"

void RC_Init(bsp_uart_id_t uartx, uint8_t *rx_buf, uint16_t dma_buf_num)
{
  BSP_UART_DMA_RX_Config cfg = {
    .uartx       = uartx,
    .buffer      = rx_buf,
    .buffer_size = dma_buf_num,
    .rx_cb       = NULL,
  };
  bsp_uart_dma_rx_init(&cfg);
}

void RC_unable(void)
{
  bsp_uart_dma_rx_stop(BSP_UART2);
}

void RC_restart(uint16_t dma_buf_num)
{
  (void)dma_buf_num;   /* buffer length is registered in the bsp handle */
  bsp_uart_dma_rx_restart(BSP_UART2);
}
