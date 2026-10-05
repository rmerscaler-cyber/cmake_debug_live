#ifndef BSP_RC_H
#define BSP_RC_H

#include "bsp_usart.h"

/* Remote control (SBUS over USART2) thin wrapper.
 * The DMA/IDLE layer lives in bsp_usart; the frame parser registers its
 * callback through bsp_uart_dma_rx_register_cb(). */
void RC_Init(bsp_uart_id_t uartx, uint8_t *rx_buf, uint16_t dma_buf_num);
void RC_unable(void);
void RC_restart(uint16_t dma_buf_num);

#endif
