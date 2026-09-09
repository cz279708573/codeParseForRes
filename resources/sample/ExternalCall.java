package com.demo;

import org.springframework.core.GenericTypeResolver;
import org.springframework.context.ApplicationContextInitializer;

/**
 * 验证外部类调用是否产生 external 节点
 */
public class ExternalCall {

    public void resolve(Class<?> clazz) {
        Class<?> type = GenericTypeResolver.resolveTypeArgument(clazz, ApplicationContextInitializer.class);
    }
}
